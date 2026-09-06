#!/usr/bin/env node
// Check docs/features.js against git, and the pages against the catalogue.
//
//   node scripts/dev/check-docs.mjs
//
// The showcase site's whole claim is that its numbers are real, so they are
// recomputed here rather than trusted: for each feature, `ins`/`del` are the
// sum of `git show --numstat` over exactly its commits, and `files` is the sum
// of each commit's own file count. Same definition the reference fork uses.
//
// It also refuses the failure modes a hand-maintained catalogue actually has:
// a commit claimed by two features, a commit that is not on the branch, a
// detail entry for a feature that no longer exists, a link to a page that is
// not there, and a capture referenced but never committed.
//
// Exit code 1 on any failure, with every failure listed rather than the first.

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const docs = join(repo, 'docs')

const failures = []
const fail = (msg) => failures.push(msg)
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim()

// ---------------------------------------------------------------- load

// The catalogue is browser code assigning onto `window`, so it is evaluated
// against a stand-in rather than imported.
function loadBrowserGlobals (...files) {
    const sandbox = { window: {} }
    vm.createContext(sandbox)
    for (const file of files) {
        vm.runInContext(readFileSync(join(docs, file), 'utf8'), sandbox, { filename: file })
    }
    return sandbox.window
}

const { FEATURES, FEATURE_DETAILS } = loadBrowserGlobals('features.js', 'feature-details.js')

if (!Array.isArray(FEATURES) || !FEATURES.length) {
    console.error('features.js defined no FEATURES array')
    process.exit(1)
}

// ---------------------------------------------------------- shape and ids

const ids = new Set()
const catLabels = new Map()
const claimedBy = new Map()

for (const f of FEATURES) {
    const where = `feature "${f.id ?? '(no id)'}"`
    for (const key of ['id', 'title', 'cat', 'catLabel', 'dateAdded', 'desc']) {
        if (typeof f[key] !== 'string' || !f[key]) { fail(`${where}: missing or empty ${key}`) }
    }
    for (const key of ['files', 'ins', 'del']) {
        if (!Number.isInteger(f[key])) { fail(`${where}: ${key} is not an integer`) }
    }
    if (!Array.isArray(f.commits) || !f.commits.length) { fail(`${where}: no commits`) }
    if (ids.has(f.id)) { fail(`${where}: duplicate id`) }
    ids.add(f.id)

    // `desc` is inserted escaped everywhere, so raw markup in it would be
    // shown as literal text — which reads as a typo rather than as a bug.
    if (/<[a-z/]/i.test(f.desc) || /&[a-z]+;/i.test(f.desc)) {
        fail(`${where}: desc must be plain text — it is escaped wherever it is rendered`)
    }

    if (catLabels.has(f.cat) && catLabels.get(f.cat) !== f.catLabel) {
        fail(`${where}: cat "${f.cat}" is labelled both "${catLabels.get(f.cat)}" and "${f.catLabel}"`)
    }
    catLabels.set(f.cat, f.catLabel)

    for (const sha of f.commits ?? []) {
        if (claimedBy.has(sha)) { fail(`commit ${sha} is claimed by both "${claimedBy.get(sha)}" and "${f.id}"`) }
        claimedBy.set(sha, f.id)
    }
}

for (const id of Object.keys(FEATURE_DETAILS ?? {})) {
    if (!ids.has(id)) { fail(`feature-details.js has an entry for "${id}", which is not in the catalogue`) }
}

// ------------------------------------------------------------------ git

let base = null
try {
    base = git('merge-base', 'HEAD', 'upstream/master')
} catch {
    console.warn('no upstream/master — skipping the git checks (fetch it to run them)')
}

if (base) {
    const onBranch = new Set(git('log', '--format=%h', `${base}..HEAD`).split('\n').filter(Boolean))

    for (const f of FEATURES) {
        let ins = 0
        let del = 0
        let files = 0
        const dates = []
        for (const sha of f.commits ?? []) {
            if (!onBranch.has(sha)) {
                fail(`feature "${f.id}": commit ${sha} is not in ${base.slice(0, 9)}..HEAD`)
                continue
            }
            const numstat = git('show', '--numstat', '--format=', sha).split('\n').filter(Boolean)
            files += numstat.length
            for (const line of numstat) {
                const [a, b] = line.split('\t')
                // A binary file reports "-" for both counts; it still counts
                // as a file touched.
                if (a !== '-') { ins += Number(a); del += Number(b) }
            }
            dates.push(git('log', '-1', '--format=%ad', '--date=short', sha))
        }
        if (!dates.length) { continue }
        dates.sort()

        if (ins !== f.ins) { fail(`feature "${f.id}": ins is ${f.ins}, git says ${ins}`) }
        if (del !== f.del) { fail(`feature "${f.id}": del is ${f.del}, git says ${del}`) }
        if (files !== f.files) { fail(`feature "${f.id}": files is ${f.files}, git says ${files}`) }
        if (dates[0] !== f.dateAdded) { fail(`feature "${f.id}": dateAdded is ${f.dateAdded}, earliest commit is ${dates[0]}`) }
    }

    // Not every commit belongs in the catalogue — a revert, a docs commit, a
    // build patch — but an unclaimed one is worth a look rather than silence.
    const unclaimed = [...onBranch].filter(sha => !claimedBy.has(sha))
    if (unclaimed.length) {
        console.warn(`\n${unclaimed.length} commit(s) on the branch are in no feature:`)
        for (const sha of unclaimed) { console.warn(`  ${sha}  ${git('log', '-1', '--format=%s', sha)}`) }
        console.warn('  (fine for reverts, docs and build patches — otherwise the catalogue is behind)')
    }
}

// ------------------------------------------------------------ the pages

const pages = ['index.html', 'features.html', 'feature.html']
for (const page of pages) {
    // Script *bodies* are stripped first — they build hrefs by concatenation,
    // so scanning them finds fragments like `' + href(f) + '` and reports
    // every page as broken. The opening tags are kept, so a `<script src>`
    // pointing at a file that is not there is still caught.
    const html = readFileSync(join(docs, page), 'utf8')
        .replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>')
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const target = m[1]
        if (/^(https?:|mailto:|#|data:)/.test(target)) { continue }
        const [path] = target.split(/[?#]/)
        if (!path) { continue }
        if (!existsSync(join(docs, path))) { fail(`${page}: links to ${target}, which does not exist`) }
    }
}

// A capture is named by a base and resolves to four possible files. Nothing
// may claim one that was never committed — a broken image on a page whose
// whole point is honesty is the worst kind of typo.
for (const [id, d] of Object.entries(FEATURE_DETAILS ?? {})) {
    for (const item of d.media ?? []) {
        const ext = item.kind === 'video' ? 'mp4' : 'png'
        const any = ['light', 'dark'].some(theme => existsSync(join(docs, 'media', `${item.base}-${theme}.${ext}`)))
        if (!any) { fail(`feature "${id}": media "${item.base}" has no file in docs/media`) }
    }
}

// ---------------------------------------------------------------- report

if (failures.length) {
    console.error(`\n${failures.length} problem(s):`)
    for (const f of failures) { console.error(`  ${f}`) }
    process.exit(1)
}
console.log(`docs OK — ${FEATURES.length} features, ${claimedBy.size} commits, ${Object.keys(FEATURE_DETAILS ?? {}).length} with long-form pages`)
