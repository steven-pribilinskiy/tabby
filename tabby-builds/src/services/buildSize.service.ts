import * as fs from 'fs/promises'
import * as path from 'path'
import { Injectable } from '@angular/core'

import { BuildSize, TabbyBuild } from '../api'

/** Guard against a walk that has clearly wandered somewhere it should not be. */
const MAX_FILES = 200000

/**
 * Size on disk, computed off the render path.
 *
 * An unpacked Electron build is ~3000 files and half a gigabyte; walking one is
 * fine, walking four at once while the user is trying to read the page is not.
 * So sizes are queued, computed one at a time, and cached until something says
 * the build changed.
 */
@Injectable({ providedIn: 'root' })
export class BuildSizeService {
    private cache = new Map<string, BuildSize>()
    private queue: { build: TabbyBuild, onDone: () => void }[] = []
    private pending = new Set<string>()
    private running = false

    get (build: TabbyBuild): BuildSize | null {
        return this.cache.get(build.id) ?? null
    }

    /** Measure this build unless it is already measured or already queued. */
    request (build: TabbyBuild, onDone: () => void): void {
        const cached = this.cache.get(build.id)
        if (cached) {
            build.size = cached
            return
        }
        if (this.pending.has(build.id)) {
            return
        }
        this.pending.add(build.id)
        this.queue.push({ build, onDone })
        void this.drain()
    }

    /** Drop a cached size so the next request re-walks. */
    invalidate (build: TabbyBuild): void {
        this.cache.delete(build.id)
        build.size = null
    }

    invalidateAll (): void {
        this.cache.clear()
    }

    private async drain (): Promise<void> {
        if (this.running) {
            return
        }
        this.running = true
        try {
            while (this.queue.length) {
                const { build, onDone } = this.queue.shift()!
                build.sizeState = 'computing'
                try {
                    const size = await this.measure(build)
                    this.cache.set(build.id, size)
                    build.size = size
                    build.sizeState = 'idle'
                } catch {
                    build.sizeState = 'error'
                }
                this.pending.delete(build.id)
                onDone()
            }
        } finally {
            this.running = false
        }
    }

    private async measure (build: TabbyBuild): Promise<BuildSize> {
        let bytes = 0
        let files = 0
        for (const root of [build.root, ...build.extraPaths]) {
            const stack = [root]
            while (stack.length) {
                const dir = stack.pop()!
                let entries: any[] = []
                try {
                    entries = await fs.readdir(dir, { withFileTypes: true })
                } catch {
                    // A plain file was handed in (an installer), or it vanished.
                    try {
                        const stat = await fs.lstat(dir)
                        if (stat.isFile()) {
                            bytes += stat.size
                            files++
                        }
                    } catch {
                        // Gone. Nothing to count.
                    }
                    continue
                }
                for (const entry of entries) {
                    const full = path.join(dir, entry.name)
                    // Never follow links: builtin-plugins is a farm of junctions
                    // back into the checkout, and following them would count the
                    // same bytes several times over.
                    if (entry.isSymbolicLink()) {
                        continue
                    }
                    if (entry.isDirectory()) {
                        stack.push(full)
                        continue
                    }
                    try {
                        const stat = await fs.lstat(full)
                        bytes += stat.size
                        files++
                    } catch {
                        // Raced with a delete.
                    }
                    if (files > MAX_FILES) {
                        throw new Error('Too many files')
                    }
                }
            }
        }
        return { bytes, files, computedAt: Date.now() }
    }
}
