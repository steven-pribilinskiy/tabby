#!/usr/bin/env node
// Cut an immutable build slot from the current checkout.
//
// A slot is a frozen, self-contained copy of the app that keeps its own
// profile, so several of them run side by side and none of them changes under
// you. That is the point: the checkout moves on, a slot does not.
//
//   node scripts/make-slot.mjs                 build and install a slot
//   node scripts/make-slot.mjs --activate      ...and point the shortcuts at it
//   node scripts/make-slot.mjs --dry-run       print what would happen
//   node scripts/make-slot.mjs --skip-build    package what is already in dist/
//
// Slots are named `<version>-<MMDD>-<HHmm>-<sha>`: the timestamp comes before
// the hash because that is the part you can actually read in a Start-menu
// search result, where the tail of a long name is what gets cut off.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync, execSync } from 'node:child_process'
import * as url from 'node:url'
import yaml from 'js-yaml'

import { version } from './vars.mjs'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const repo = path.resolve(__dirname, '..')

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const activate = args.has('--activate')
const skipBuild = args.has('--skip-build')

const SLOTS_ROOT = path.join(os.homedir(), 'Tabby', 'builds')
const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'tabby')

const git = (cmd, fallback = 'unknown') => {
    try {
        return execSync(`git ${cmd}`, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
        return fallback
    }
}

const pad = n => String(n).padStart(2, '0')

function slotName (now, sha) {
    const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
    return `${version}-${stamp}-${sha}`
}

/**
 * What the slot records about itself. Read back by the Builds settings page,
 * which prefers it to the executable's version resource — a slot binary
 * reports 1.0.0, because electron-builder stamps it from app/package.json.
 */
function buildInfo (slot, sha, branch, upstream, now) {
    const commits = git(`log --oneline ${upstream.base}..HEAD`, '')
    return [
        'Tabby fork - immutable build slot',
        '================================',
        '',
        `Slot:          ${slot}`,
        `Built:         ${now.toISOString()}`,
        `Repo:          ${repo}   (branch: ${branch})`,
        `Commit:        ${git('rev-parse HEAD')}`,
        `Upstream base: ${upstream.base}  (Eugeny/tabby master${upstream.tag ? `, tag ${upstream.tag}` : ''})`,
        '',
        'Versions',
        '--------',
        `Electron:   ${readJSON(path.join(repo, 'node_modules', 'electron', 'package.json'))?.version ?? '?'}`,
        `Angular:    ${readJSON(path.join(repo, 'node_modules', '@angular', 'core', 'package.json'))?.version ?? '?'}`,
        `xterm:      ${readJSON(path.join(repo, 'node_modules', '@xterm', 'xterm', 'package.json'))?.version ?? '?'}`,
        '',
        'Fork commits on top of upstream master',
        '--------------------------------------',
        commits,
        '',
        'Runtime layout',
        '--------------',
        'data\\             portable userData (app/lib/portable.ts redirects here)',
        'data\\config.yaml  seeded from %APPDATA%\\tabby\\config.yaml at build time',
        'data\\plugins      junction -> %APPDATA%\\tabby\\plugins (shared, live)',
        '',
        'Notes',
        '-----',
        '- App files are read-only; data\\ stays writable.',
        '- To retire: close ONLY this instance (match on path *\\Tabby\\builds\\*)',
        '  and delete the slot directory. The Builds settings page does both.',
        '',
    ].join('\n')
}

function readJSON (p) {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'))
    } catch {
        return null
    }
}

/** The commit this fork branched from, so the slot can say what it is based on. */
function upstreamBase () {
    const base = git('merge-base HEAD upstream/master', '')
        || git('merge-base HEAD origin/master', '')
    if (!base) {
        return { base: 'unknown', tag: null }
    }
    return {
        base: base.slice(0, 8),
        tag: git(`describe --tags --abbrev=0 ${base}`, null),
    }
}

/**
 * The profile a slot starts with: yours, minus the two settings that would
 * make two instances fight. A slot is meant to run *alongside* your Tabby, not
 * instead of it.
 */
function seedConfig (target) {
    const source = path.join(USER_DATA, 'config.yaml')
    let config = {}
    try {
        config = yaml.load(fs.readFileSync(source, 'utf-8')) ?? {}
    } catch {
        console.log('  no existing config to seed from; starting empty')
    }
    // Leave the global hotkey to the primary install, or whichever instance
    // grabbed it first wins and the other silently does nothing.
    config.hotkeys = { ...config.hotkeys ?? {}, 'toggle-window': [] }
    // Only one instance can bind the MCP server's port.
    const blacklist = new Set(config.pluginBlacklist ?? [])
    blacklist.add('mcp-server')
    config.pluginBlacklist = [...blacklist]
    fs.writeFileSync(target, yaml.dump(config))
}

function run (command, cmdArgs, cwd = repo) {
    console.log(`  $ ${command} ${cmdArgs.join(' ')}`)
    if (dryRun) {
        return
    }
    execFileSync(command, cmdArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
}

/** Mark the application files read-only so a slot cannot drift after it is cut. */
function freeze (dir) {
    if (process.platform !== 'win32') {
        return
    }
    // /D exempts data\, which has to stay writable.
    run('attrib', ['+R', path.join(dir, '*'), '/S', '/D', '/L'], dir)
}

const now = new Date()
const sha = git('rev-parse --short=8 HEAD')
const branch = git('rev-parse --abbrev-ref HEAD')
const upstream = upstreamBase()
const slot = slotName(now, sha)
const target = path.join(SLOTS_ROOT, slot)
const unpacked = path.join(repo, 'dist', 'win-unpacked')

console.log(`slot:   ${slot}`)
console.log(`from:   ${branch} @ ${sha} (upstream base ${upstream.base})`)
console.log(`target: ${target}`)

if (git('status --porcelain', '')) {
    console.log('\nWARNING: the working tree is dirty. The slot will record the current')
    console.log('commit, but the bundle is compiled from the tree — those differ.\n')
}

if (fs.existsSync(target)) {
    console.error(`\nA slot already exists at ${target}. Nothing to do.`)
    process.exit(1)
}

if (!skipBuild) {
    console.log('\nbuilding')
    run('yarn', ['run', 'build'])
    run('node', ['scripts/prepackage-plugins.mjs'])
    // --dir only: a slot is an unpacked directory, never an installer.
    run('npx', ['electron-builder', '--win', '--dir'])
}

if (!dryRun && !fs.existsSync(unpacked)) {
    console.error(`\nNo build output at ${unpacked}. Run without --skip-build.`)
    process.exit(1)
}

console.log('\ninstalling the slot')
if (!dryRun) {
    fs.mkdirSync(target, { recursive: true })
    fs.cpSync(unpacked, target, { recursive: true })
    fs.mkdirSync(path.join(target, 'data'), { recursive: true })
    seedConfig(path.join(target, 'data', 'config.yaml'))
    // A junction rather than a copy: plugins stay shared and live, and the
    // Builds page knows not to follow it when sizing or deleting a slot.
    const plugins = path.join(target, 'data', 'plugins')
    const shared = path.join(USER_DATA, 'plugins')
    if (fs.existsSync(shared) && !fs.existsSync(plugins)) {
        execFileSync('cmd', ['/c', 'mklink', '/J', plugins, shared], { stdio: 'ignore' })
    }
    fs.writeFileSync(path.join(target, 'BUILD-INFO.txt'), buildInfo(slot, sha, branch, upstream, now))
    freeze(target)
}

if (activate) {
    console.log('\npointing the shortcuts at this slot')
    const exe = path.join(target, 'Tabby.exe')
    const shortcuts = [
        path.join(os.homedir(), 'Tabby', 'Tabby-fork.lnk'),
        path.join(process.env.APPDATA ?? '', 'Microsoft', 'Internet Explorer',
            'Quick Launch', 'User Pinned', 'TaskBar', 'Tabby.lnk'),
    ].filter(p => fs.existsSync(p))
    for (const lnk of shortcuts) {
        console.log(`  ${lnk}`)
        if (dryRun) {
            continue
        }
        const ps = [
            '$s = New-Object -ComObject WScript.Shell',
            `$l = $s.CreateShortcut('${lnk.replace(/'/g, '\'\'')}')`,
            `$l.TargetPath = '${exe.replace(/'/g, '\'\'')}'`,
            `$l.WorkingDirectory = '${target.replace(/'/g, '\'\'')}'`,
            `$l.IconLocation = '${exe.replace(/'/g, '\'\'')},0'`,
            `$l.Description = 'Tabby fork (local) - portable slot ${slot}'`,
            '$l.Save()',
        ].join('; ')
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' })
    }
}

console.log(`\n${dryRun ? 'would have created' : 'created'} ${slot}`)
