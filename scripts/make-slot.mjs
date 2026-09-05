#!/usr/bin/env node
// Cut a build slot from the current checkout.
//
// A slot is a frozen, self-contained copy of the app that keeps its own
// profile, so both of them run side by side and neither changes under you.
// That is the point: the checkout moves on, a slot does not.
//
// There are exactly two, after the model the Windows Terminal fork uses for
// `wtd` / `wtt`, and they are not two equivalent scratch installs:
//
//   canary   disposable. Every build replaces it. Yours to break, and the
//            only one this script will ever overwrite on its own.
//   dev      production — the Tabby you actually work in. It changes exactly
//            one way: you promote canary into it. Never built into directly.
//
//   node scripts/make-slot.mjs                 build and install canary
//   node scripts/make-slot.mjs --promote       copy canary into dev
//   node scripts/make-slot.mjs --dry-run       print what would happen
//   node scripts/make-slot.mjs --skip-build    install what is already in dist/
//   node scripts/make-slot.mjs --seed-from D   take the starting profile from D
//
// Two fixed names, rather than `<version>-<MMDD>-<HHmm>-<sha>` directories that
// accumulate one per build until the disk notices. It also retires the whole
// business of retargeting shortcuts: a slot's path never changes now, so a pin
// made once stays correct for ever, and `--activate` is gone with it.
//
// What a slot *is* still gets recorded, in its own BUILD-INFO.txt and in the
// Builds settings page — the name says which slot, the sidecar says which
// commit.

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync, execSync } from 'node:child_process'
import * as url from 'node:url'
import yaml from 'js-yaml'

import { version } from './vars.mjs'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const repo = path.resolve(__dirname, '..')

const argv = process.argv.slice(2)
const args = new Set(argv)
const seedFrom = argv.includes('--seed-from') ? argv[argv.indexOf('--seed-from') + 1] : null
const dryRun = args.has('--dry-run')
const promote = args.has('--promote')
const skipBuild = args.has('--skip-build')

const SLOTS_ROOT = path.join(os.homedir(), 'Tabby', 'builds')
const USER_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'tabby')

/** The only two slot directories that may exist. */
const SLOTS = {
    canary: { dir: 'canary', label: 'canary', shortcut: 'Tabby-fork-canary.lnk' },
    dev: { dir: 'dev', label: 'dev', shortcut: 'Tabby-fork-dev.lnk' },
}

const git = (cmd, fallback = 'unknown') => {
    try {
        return execSync(`git ${cmd}`, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
        return fallback
    }
}

const pad = n => String(n).padStart(2, '0')

/**
 * What the directory name used to carry.
 *
 * A slot's name is fixed now, so the version, the moment it was cut and the
 * commit go in BUILD-INFO.txt instead — which is where the Builds page reads
 * them from anyway, in preference to the executable's version resource.
 */
function buildStamp (now, sha) {
    const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
    return `${version}-${stamp}-${sha}`
}

/**
 * What the slot records about itself. Read back by the Builds settings page,
 * which prefers it to the executable's version resource — a slot binary
 * reports 1.0.0, because electron-builder stamps it from app/package.json.
 */
function buildInfo (role, stamp, sha, head, branch, upstream, now) {
    const commits = git(`log --oneline ${upstream.base}..${head}`, '')
    return [
        'Tabby fork - build slot',
        '=======================',
        '',
        `Slot:          ${role}   (${role === 'dev'
            ? 'production - the Tabby you work in; changes only when canary is promoted'
            : 'disposable - replaced by every build'})`,
        `Build:         ${stamp}`,
        `Built:         ${now.toISOString()}`,
        `Repo:          ${repo}   (branch: ${branch})`,
        `Commit:        ${head}`,
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
        'data\\config.yaml  this slot\'s own settings; kept across rebuilds of it',
        'data\\plugins      junction -> %APPDATA%\\tabby\\plugins (shared, live)',
        '',
        'Notes',
        '-----',
        '- App files are read-only; data\\ stays writable.',
        '- There are only ever two slots, canary and dev, so neither the',
        '  directories nor the shortcuts pointing at them ever go stale.',
        '- Rebuilding a slot keeps its data\\ - settings survive, binaries do not.',
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
 * Where a slot's settings come from, when it does not already have some.
 *
 * Fixed slot names make this the simple question it always should have been.
 * Rebuilding a slot *keeps its own* `data\`, so the usual answer is "nowhere,
 * it already has settings" — which is the whole of what the old pin-hunting
 * was trying to approximate, and got wrong whenever two instances were running.
 *
 * A genuinely new slot starts from the other slot's profile — a new canary from
 * dev, because dev is the Tabby you actually use, and a new dev from the canary
 * being promoted into it — and from the installed app only when there is no
 * other slot at all. Printed either way, and `--seed-from` overrides it.
 */
function seedSource () {
    if (seedFrom) {
        return path.join(seedFrom, 'config.yaml')
    }
    const other = path.join(SLOTS_ROOT, promote ? SLOTS.canary.dir : SLOTS.dev.dir,
        'data', 'config.yaml')
    return fs.existsSync(other) ? other : path.join(USER_DATA, 'config.yaml')
}

/** Any process currently running from `dir`, so a slot in use is never replaced. */
function runningIn (dir) {
    if (process.platform !== 'win32') {
        return []
    }
    try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            "Get-Process -Name Tabby -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id)|$($_.Path)\" }"],
        { encoding: 'utf-8', windowsHide: true, timeout: 20000 })
        return out.split(/\r?\n/).map(x => x.trim()).filter(Boolean)
            .map(line => { const [pid, exe] = line.split('|'); return { pid: Number(pid), exe } })
            .filter(p => p.exe && p.exe.toLowerCase().startsWith(dir.toLowerCase() + path.sep))
    } catch {
        return []
    }
}

/**
 * Delete a slot, junction first.
 *
 * `data\plugins` is a junction into %APPDATA%\tabby\plugins, which is shared
 * and live. Node reports it as a symlink, so `fs.rm` unlinks it rather than
 * descending into it — but it is removed explicitly first anyway, because the
 * cost of being wrong about that is everyone's plugins. The read-only bit that
 * `freeze()` set has to come off first or the delete fails on Windows.
 */
function removeSlot (dir) {
    if (!fs.existsSync(dir)) {
        return
    }
    const plugins = path.join(dir, 'data', 'plugins')
    if (fs.existsSync(plugins) && fs.lstatSync(plugins).isSymbolicLink()) {
        fs.rmdirSync(plugins)
    }
    if (process.platform === 'win32') {
        try {
            execFileSync('attrib', ['-R', path.join(dir, '*'), '/S', '/D'], { stdio: 'ignore' })
        } catch {
            // Nothing was read-only.
        }
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
}
/**
 * The profile a slot starts with: yours, minus the two settings that would
 * make two instances fight. A slot is meant to run *alongside* your Tabby, not
 * instead of it.
 */
function seedConfig (target, source) {
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

/**
 * Mark the application files read-only so a slot cannot drift after it is cut.
 *
 * `data\` is skipped by *name*, one attrib call per top-level entry. A single
 * `attrib +R <slot>\* /S` over the whole slot also freezes `data\config.yaml`,
 * and then every settings change in that slot fails: `app/lib/config.ts` writes
 * through `atomically`, whose rename over a read-only file is EPERM on Windows,
 * so `ConfigService.save()` throws before `emitChange()` — nothing persists and
 * nothing that reacts to `config.changed$` (spaciness, theme) updates either.
 *
 * `/D` does not exempt anything; it *adds* folders to what attrib touches. Only
 * files matter here — Windows ignores the read-only bit on a directory — so it
 * is not used. `/L` acts on the `data\plugins` junction rather than following it
 * into `%APPDATA%\tabby\plugins`.
 */
function freeze (dir) {
    if (process.platform !== 'win32') {
        return
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'data') {
            continue
        }
        const target = path.join(dir, entry.name)
        run('attrib', entry.isDirectory()
            ? ['+R', `"${path.join(target, '*')}"`, '/S', '/L']
            : ['+R', `"${target}"`, '/L'], dir)
    }
}

/**
 * The one thing a frozen slot must still be able to write. Checked rather than
 * assumed, because the failure is silent at runtime: the app saves settings and
 * they simply do not come back.
 */
function assertProfileWritable (dir) {
    const config = path.join(dir, 'data', 'config.yaml')
    try {
        fs.accessSync(config, fs.constants.W_OK)
    } catch {
        console.error(`\n${config} is not writable — the slot would silently drop every settings change.`)
        process.exit(1)
    }
}

const now = new Date()
// Resolved once: a commit made while the build runs would otherwise leave the
// slot's name and its recorded commit disagreeing.
const head = git('rev-parse HEAD')
const sha = head.slice(0, 8)
const branch = git('rev-parse --abbrev-ref HEAD')
const upstream = upstreamBase()
const stamp = buildStamp(now, sha)
const slot = promote ? SLOTS.dev : SLOTS.canary
const target = path.join(SLOTS_ROOT, slot.dir)
const canary = path.join(SLOTS_ROOT, SLOTS.canary.dir)
const unpacked = path.join(repo, 'dist', 'win-unpacked')
// Promotion moves the canary that was already built and tried, not a fresh
// compile of whatever the tree happens to say now — otherwise "promote what I
// verified" would silently mean "build something new and call it verified".
const source = promote ? canary : unpacked
const seed = seedSource()
const keepsSettings = fs.existsSync(path.join(target, 'data', 'config.yaml'))

console.log(`slot:   ${slot.label}${promote ? '  (promoting canary)' : ''}`)
console.log(`build:  ${stamp}`)
console.log(`from:   ${branch} @ ${sha} (upstream base ${upstream.base})`)
console.log(`target: ${target}`)
console.log(`seed:   ${keepsSettings ? `${target}\\data\\config.yaml (kept)` : seed}`)

if (!promote && git('status --porcelain', '')) {
    console.log('\nWARNING: the working tree is dirty. The slot will record the current')
    console.log('commit, but the bundle is compiled from the tree — those differ.\n')
}

if (promote && !fs.existsSync(path.join(canary, 'Tabby.exe'))) {
    console.error(`\nNothing to promote: there is no canary at ${canary}.`)
    process.exit(1)
}

// Never replace a slot that is open. dev especially: it is where the live
// sessions are, and swapping its binaries out from under it is how you lose
// them. The check is on this slot's own path, not "any Tabby" — the whole
// point of two slots is that the other one keeps running.
const busy = runningIn(target)
if (busy.length && !dryRun) {
    console.error(`\n${slot.label} is running (PID ${busy.map(p => p.pid).join(', ')}).`)
    console.error('Close that window first — replacing it underneath would take it down with it.')
    process.exit(1)
}

if (!promote && !skipBuild) {
    console.log('\nbuilding')
    run('yarn', ['run', 'build'])
    run('node', ['scripts/prepackage-plugins.mjs'])
    // --dir only: a slot is an unpacked directory, never an installer.
    run('npx', ['electron-builder', '--win', '--dir'])
}

if (!dryRun && !fs.existsSync(source)) {
    console.error(`\nNo build output at ${source}. Run without --skip-build.`)
    process.exit(1)
}

console.log(`\ninstalling ${slot.label}`)
if (!dryRun) {
    // Application files only: `data\` is this slot's settings and survives
    // being rebuilt. Replacing them in place also means the slot's path, and
    // so every shortcut and pin aimed at it, stays valid.
    fs.mkdirSync(target, { recursive: true })
    if (process.platform === 'win32') {
        try {
            execFileSync('attrib', ['-R', path.join(target, '*'), '/S', '/D'], { stdio: 'ignore' })
        } catch {
            // Nothing was frozen yet.
        }
    }
    for (const entry of fs.readdirSync(target)) {
        if (entry !== 'data') {
            fs.rmSync(path.join(target, entry), { recursive: true, force: true, maxRetries: 3 })
        }
    }
    for (const entry of fs.readdirSync(source)) {
        if (entry !== 'data') {
            fs.cpSync(path.join(source, entry), path.join(target, entry), { recursive: true })
        }
    }
    // Again, after the copy: promoting copies a *frozen* canary, and cpSync
    // brings the read-only bit with it — so BUILD-INFO.txt would arrive
    // read-only and the write below would fail EPERM. freeze() puts it back.
    if (process.platform === 'win32') {
        try {
            execFileSync('attrib', ['-R', path.join(target, '*'), '/S', '/D'], { stdio: 'ignore' })
        } catch {
            // Nothing was read-only.
        }
    }

    fs.mkdirSync(path.join(target, 'data'), { recursive: true })
    if (!keepsSettings) {
        seedConfig(path.join(target, 'data', 'config.yaml'), seed)
    }
    // A junction rather than a copy: plugins stay shared and live, and the
    // Builds page knows not to follow it when sizing or deleting a slot.
    const plugins = path.join(target, 'data', 'plugins')
    const shared = path.join(USER_DATA, 'plugins')
    if (fs.existsSync(shared) && !fs.existsSync(plugins)) {
        execFileSync('cmd', ['/c', 'mklink', '/J', plugins, shared], { stdio: 'ignore' })
    }
    // Promotion records what canary recorded. The point of promoting is that
    // dev runs the thing you already tried, so re-deriving this from HEAD
    // would let dev claim a commit that was never in the binaries.
    fs.writeFileSync(path.join(target, 'BUILD-INFO.txt'), promote
        ? fs.readFileSync(path.join(canary, 'BUILD-INFO.txt'), 'utf-8')
            .replace(/^Slot:.*$/m, 'Slot:          dev   (production - promoted from canary)')
            + `Promoted:      ${now.toISOString()}\n`
        : buildInfo(slot.dir, stamp, sha, head, branch, upstream, now))
    freeze(target)
    assertProfileWritable(target)
}

// One shortcut per slot, created once and never retargeted: the paths are
// fixed, so a pin made from either of these stays correct for ever. That is
// the whole reason the timestamped directory names went.
console.log('\nshortcuts')
const exe = path.join(target, 'Tabby.exe')
for (const lnk of [
    path.join(os.homedir(), 'Tabby', slot.shortcut),
    // The Start menu entry is the one Windows will let you pin: *Pin to Start*
    // and *Pin to taskbar* appear for Start menu apps and for nothing else.
    path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu',
        'Programs', slot.shortcut),
]) {
    console.log(`  ${lnk}`)
    if (dryRun) {
        continue
    }
    fs.mkdirSync(path.dirname(lnk), { recursive: true })
    const ps = [
        '$s = New-Object -ComObject WScript.Shell',
        `$l = $s.CreateShortcut('${lnk.replace(/'/g, '\'\'')}')`,
        `$l.TargetPath = '${exe.replace(/'/g, '\'\'')}'`,
        `$l.WorkingDirectory = '${target.replace(/'/g, '\'\'')}'`,
        `$l.IconLocation = '${exe.replace(/'/g, '\'\'')},0'`,
        `$l.Description = 'Tabby fork (local) - ${slot.label} slot'`,
        '$l.Save()',
    ].join('; ')
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' })
}

// There are two slots. Anything else under the root is a leftover from the
// timestamped scheme, and left alone it is exactly the pile-up this replaced.
const strays = (fs.existsSync(SLOTS_ROOT) ? fs.readdirSync(SLOTS_ROOT, { withFileTypes: true }) : [])
    .filter(e => e.isDirectory() && ![SLOTS.canary.dir, SLOTS.dev.dir].includes(e.name))
if (strays.length) {
    console.log('\npruning slots that are neither canary nor dev')
    for (const stray of strays) {
        const dir = path.join(SLOTS_ROOT, stray.name)
        const open = runningIn(dir)
        if (open.length) {
            console.log(`  ${stray.name} — still running (PID ${open.map(p => p.pid).join(', ')}), left alone`)
            continue
        }
        console.log(`  ${stray.name} — removed`)
        if (!dryRun) {
            removeSlot(dir)
        }
    }
}

console.log(`\n${dryRun ? 'would have installed' : 'installed'} ${slot.label} (${stamp})`)
if (!promote) {
    console.log('promote it with:  node scripts/make-slot.mjs --promote')
}
