/**
 * Picking the pane's own process out of what a probe reported.
 *
 * Separate from `recognize.ts`, which is about commands, and separate from the
 * service, which is about I/O: this is the selection step in between, and the
 * half most easily got wrong — the deepest descendant instead of the first, or
 * a daemon that inherited the pane's identity instead of the pane itself.
 * Pure, so the tests can run it against real process trees with no app around
 * it.
 */

import { baseName, isShellName } from './recognize'

/**
 * The separators `WSL_PROBE_SCRIPT` writes between fields and between argv
 * entries. Both are C0 controls no argument or path can contain, so no
 * escaping is needed on either side.
 */
export const FIELD_SEP = '\x1e'
export const ARG_SEP = '\x1f'

/**
 * One node of what `windows-process-tree` reports. Its own typings are not
 * reachable from here — the module is an optional native dependency, required
 * inside a try — so the shape it actually returns is named here instead.
 */
export interface ProcessTreeNode {
    name?: string
    commandLine?: string
    children?: ProcessTreeNode[]
}

/** One line of `WSL_PROBE_SCRIPT` output. */
export interface WslRecord {
    sessionUID: string
    pid: number
    parentPid: number
    pgrp: number
    tpgid: number
    cwd: string
    argv: string[]
}

export function parseProbe (output: string): WslRecord[] {
    const records: WslRecord[] = []
    for (const line of output.split('\n')) {
        const fields = line.replace(/\r$/, '').split(FIELD_SEP)
        if (fields.length < 7) {
            continue
        }
        const argv = fields[6].split(ARG_SEP).filter(x => x)
        if (!argv.length) {
            continue
        }
        records.push({
            sessionUID: fields[0],
            pid: parseInt(fields[1], 10) || 0,
            parentPid: parseInt(fields[2], 10) || 0,
            pgrp: parseInt(fields[3], 10) || 0,
            tpgid: parseInt(fields[4], 10) || 0,
            cwd: fields[5],
            argv,
        })
    }
    return records
}

/**
 * The process in the pane's foreground, or null when the shell itself is all
 * there is.
 *
 * A process is the answer when it **leads the foreground process group of its
 * own controlling terminal** — `pid === pgrp === tpgid` — and has a parent
 * inside the pane, which is what separates the shell's work from the shell.
 *
 * The obvious reading of `/proc/<pid>/stat` is wrong here and cost a test run
 * to see: **`tpgid` describes the terminal, not the process.** Every process
 * sharing a controlling terminal reports the same value, so "the topmost
 * process's tpgid" is not that process's opinion about its children — it is
 * simply which group the terminal is currently listening to. Reading it off
 * whichever process happens to sit at the top of the pane therefore breaks the
 * moment anything sits between the pane and its shell, and something does: a
 * pty wrapper, a `sudo -i`, a nested shell. Measured against a real distro, a
 * pane behind one such wrapper reported nothing at all.
 *
 * Reading it as "am I the group the terminal is listening to" instead makes
 * every one of those cases fall out. A pane at its prompt has only its shell,
 * which is a root, so nothing qualifies and the answer is null. A pipeline
 * qualifies at its leader — the command that was typed. An agent that spawns a
 * child per MCP server qualifies at the agent, because those children are in
 * its group and are not its leader. And a nested pty qualifies twice, which is
 * why depth breaks the tie: the shallowest is the one the pane's own shell
 * started, and the deeper one is inside it.
 */
export function foregroundOf (records: WslRecord[], sessionUID: string): WslRecord | null {
    if (!sessionUID) {
        return null
    }
    const mine = records.filter(x => x.sessionUID === sessionUID)
    if (!mine.length) {
        return null
    }
    const byPid = new Map(mine.map(x => [x.pid, x]))
    // Distance from the pane, so a tie is broken towards what the pane's own
    // shell started rather than what that in turn started.
    const depths = new Map<number, number>()
    const depthOf = (record: WslRecord): number => {
        let depth = 0
        let at: WslRecord | undefined = record
        const seen = new Set<number>()
        while (at && !seen.has(at.pid)) {
            const cached = depths.get(at.pid)
            if (cached !== undefined) {
                return depth + cached
            }
            seen.add(at.pid)
            at = byPid.get(at.parentPid)
            depth++
        }
        return depth - 1
    }
    for (const record of mine) {
        depths.set(record.pid, depthOf(record))
    }

    let best: WslRecord | null = null
    let bestDepth = Infinity
    let fallback: WslRecord | null = null
    let fallbackDepth = Infinity
    for (const record of mine) {
        const depth = depths.get(record.pid) ?? 0
        if (depth === 0 || record.tpgid <= 0 || record.pgrp !== record.tpgid) {
            continue
        }
        if (record.pid === record.pgrp) {
            if (depth < bestDepth) {
                best = record
                bestDepth = depth
            }
        } else if (depth < fallbackDepth) {
            // The group's leader has already exited — a pipeline whose first
            // command finished first. Its survivors are still what the pane is
            // showing, so answer with one rather than with nothing.
            fallback = record
            fallbackDepth = depth
        }
    }
    return best ?? fallback
}

/**
 * The SHALLOWEST non-shell descendant — the first thing the pane's shell
 * actually launched.
 *
 * Not the deepest, which is wrong for exactly the case this feature exists
 * for: an agent spawns a child per MCP server, so a pane running `claude` has
 * node processes hanging off it and the deepest descendant is one of those
 * rather than claude. The WSL side gets this right from the foreground process
 * group; a native pane has no equivalent, so depth from the pane's own shell
 * stands in for it.
 *
 * Depth, rather than "the first name we recognise", so a pane running
 * something no table covers still reports honestly and the policy is left to
 * decide whether it may come back.
 */
export function firstWorkerBelow (tree: ProcessTreeNode | null | undefined): string | null {
    if (!tree) {
        return null
    }
    let queue: ProcessTreeNode[] = tree.children ?? []
    while (queue.length) {
        const next: ProcessTreeNode[] = []
        for (const node of queue) {
            const name = baseName(node.name ?? '')
            if (name && !isShellName(name)) {
                // The command line where there is one, and the bare name when
                // there is not: `windows-process-tree` reports an empty string
                // for a process whose PEB it could not read, and an empty
                // answer would look like "nothing is running here".
                return node.commandLine ? node.commandLine : node.name ?? null
            }
            next.push(...node.children ?? [])
        }
        queue = next
    }
    return null
}

/** [[firstWorkerBelow]] against a flat `ps` listing rather than a tree. */
export function firstWorkerBelowList (rootPid: number, list: Map<number, { ppid: number, argv: string[] }>): string[] | null {
    const childrenOf = new Map<number, number[]>()
    for (const [pid, info] of list) {
        const siblings = childrenOf.get(info.ppid) ?? []
        siblings.push(pid)
        childrenOf.set(info.ppid, siblings)
    }
    const seen = new Set<number>([rootPid])
    let queue = childrenOf.get(rootPid) ?? []
    while (queue.length) {
        const next: number[] = []
        for (const pid of queue) {
            const info = list.get(pid)
            if (!info) {
                continue
            }
            const name = baseName(info.argv[0] ?? '')
            if (name && !isShellName(name)) {
                return info.argv
            }
            for (const child of childrenOf.get(pid) ?? []) {
                // A recycled parent pid can otherwise loop the walk.
                if (!seen.has(child)) {
                    seen.add(child)
                    next.push(child)
                }
            }
        }
        queue = next
    }
    return null
}

