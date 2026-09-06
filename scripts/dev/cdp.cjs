// The one CDP driver every `*.cdp.js` in this repo attaches through.
//
// It exists because a debugging port is not a safe thing to assume. Chromium
// does not report a `--remote-debugging-port` it could not bind — it simply
// does not listen, and every request then goes to whatever *is* on that port.
// Measured, on this machine: a test that hardcoded 9251 attached to the user's
// own Chrome, full of logged-in tabs, and only a URL filter stopped it
// evaluating script in them. Ports 9223/9224 are worse still: svchost forwards
// them from WSL, so they answer `LISTENING` and then nothing at all.
//
// So nothing here trusts a port. A target is attached to only after
// `/json/version` has answered with valid JSON that names Electron, and the
// port itself is discovered rather than hardcoded. Both halves fail closed:
// anything unidentified is refused, never attached.
//
// `.cjs` because the root `package.json` is `"type": "module"` and every
// plugin's is not — the tests are CommonJS and `require()` this.
const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '..', '..')
const WebSocket = require(path.join(root, 'node_modules', 'ws'))

/** Where `launch-hidden.mjs` records the instances it started, one file each. */
const REGISTRY = path.join(process.env.TEMP ?? os.tmpdir(), 'tabby-cdp')

/** Searched for a free port, and swept for an instance nothing registered. */
const RANGE = { from: 9230, to: 9280 }

/** A probe of a port nobody owns must not hold the run up. */
const PROBE_MS = 1500

/** A CDP request that is never answered is how a suite comes to hang for ever. */
const REQUEST_MS = 20000

/** A Tabby renderer, as opposed to a devtools page or a service worker. */
const RENDERER = t => t.type === 'page' && t.url.includes('index.html')

// ── Ports ───────────────────────────────────────────────────────────────────

function isPortFree (port) {
    return new Promise(resolve => {
        const server = net.createServer()
        server.once('error', () => resolve(false))
        server.once('listening', () => server.close(() => resolve(true)))
        server.listen(port, '127.0.0.1')
    })
}

/**
 * The first genuinely free port, `preferred` first if it was asked for.
 *
 * Being free is necessary and not sufficient — see `requireElectron`, which is
 * what actually decides whether the thing that answers is ours.
 */
async function pickPort ({ preferred, from = RANGE.from, to = RANGE.to } = {}) {
    if (preferred && await isPortFree(preferred)) {
        return preferred
    }
    for (let port = from; port <= to; port++) {
        if (await isPortFree(port)) {
            return port
        }
    }
    throw new Error(`no free debugging port in ${from}-${to}`)
}

// ── The registry ────────────────────────────────────────────────────────────
//
// So a test can find the instance a launcher started without either of them
// naming a port, which is what let a hardcoded one persist as the default.

function registerInstance (meta) {
    fs.mkdirSync(REGISTRY, { recursive: true })
    fs.writeFileSync(path.join(REGISTRY, `${meta.port}.json`),
        JSON.stringify({ ...meta, startedAt: Date.now() }, null, 2))
}

function unregisterInstance (port) {
    try {
        fs.rmSync(path.join(REGISTRY, `${port}.json`), { force: true })
    } catch { /* the registry is a convenience, never a lock */ }
}

function alive (pid) {
    try {
        process.kill(pid, 0)
        return true
    } catch (err) {
        return err.code === 'EPERM'
    }
}

/** Registered instances whose process is still running; stale files are swept. */
function liveInstances () {
    let names = []
    try {
        names = fs.readdirSync(REGISTRY)
    } catch {
        return []
    }
    const out = []
    for (const name of names.filter(n => n.endsWith('.json'))) {
        const file = path.join(REGISTRY, name)
        try {
            const meta = JSON.parse(fs.readFileSync(file, 'utf8'))
            if (meta.pid && alive(meta.pid)) {
                out.push(meta)
                continue
            }
        } catch { /* unreadable is as good as gone */ }
        try {
            fs.rmSync(file, { force: true })
        } catch { /* someone else got there first */ }
    }
    return out
}

// ── Identity ────────────────────────────────────────────────────────────────

function fetchJson (port, urlPath, timeoutMs = PROBE_MS) {
    return new Promise((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs }, res => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', c => body += c)
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body))
                } catch {
                    reject(new Error(`port ${port} answered ${urlPath} with something that is not JSON`))
                }
            })
        })
        // 9223/9224 answer LISTENING because svchost forwards them from WSL, and
        // then say nothing. Without this the whole suite waits on the OS.
        request.on('timeout', () => request.destroy(new Error(`port ${port} did not answer ${urlPath} in ${timeoutMs}ms`)))
        request.on('error', reject)
    })
}

async function identify (port, timeoutMs = PROBE_MS) {
    const version = await fetchJson(port, '/json/version', timeoutMs)
    const agent = String(version['User-Agent'] ?? '')
    const browser = String(version.Browser ?? '')
    return { port, agent, browser, electron: agent.includes('Electron') || browser.includes('Electron') }
}

/**
 * Refuse the port unless whatever is on it says it is Electron.
 *
 * This is the whole safety story, and it runs before a socket is ever opened
 * to a target. A browser answers here too — with `Chrome/…` — and is refused.
 */
async function requireElectron (port, timeoutMs = PROBE_MS) {
    let info
    try {
        info = await identify(port, timeoutMs)
    } catch (err) {
        throw new Error(`refusing to attach on port ${port}: ${err.message}`)
    }
    if (!info.electron) {
        throw new Error(`REFUSING TO ATTACH: port ${port} is not an Electron debugger — it calls itself `
            + `${JSON.stringify(info.browser || info.agent || '(nothing)')}. Chromium does not report a `
            + `debugging port it could not bind, so this is most likely a browser of yours, not a dev build.`)
    }
    return info
}

/** An Electron endpoint serving at least one Tabby renderer, or null. */
async function probe (port) {
    try {
        const info = await identify(port)
        if (!info.electron) {
            return null
        }
        const list = await fetchJson(port, '/json/list')
        return Array.isArray(list) && list.some(RENDERER) ? { ...info, targets: list } : null
    } catch {
        return null
    }
}

// ── Finding the instance ────────────────────────────────────────────────────

/**
 * Which port to talk to, when the caller did not say.
 *
 * `CDP_PORT` wins if it is set — it is how a test asks for one particular
 * instance — but it buys no trust: `connect()` still verifies it. Otherwise the
 * running instance is *found*: registered launches first, and failing that a
 * sweep of the range, keeping only endpoints that are Electron and are serving
 * a Tabby renderer. There is deliberately no fallback constant; a default port
 * is exactly the assumption that attached to someone's browser.
 */
async function resolvePort () {
    const asked = parseInt(process.env.CDP_PORT ?? '', 10)
    if (asked) {
        return { port: asked, source: 'CDP_PORT' }
    }

    const registered = liveInstances()
    const candidates = registered.length
        ? registered.map(i => i.port)
        : Array.from({ length: RANGE.to - RANGE.from + 1 }, (_, i) => RANGE.from + i)

    const found = (await Promise.all(candidates.map(async port =>
        await probe(port) ? port : null))).filter(p => p !== null)

    if (found.length === 1) {
        return { port: found[0], source: registered.length ? 'a registered launch' : 'a sweep of the port range' }
    }
    if (found.length > 1) {
        throw new Error(`${found.length} dev builds are listening (ports ${found.join(', ')}) — say which with CDP_PORT`)
    }
    throw new Error('no hidden dev build is listening. Start one with '
        + '`node scripts/dev/launch-hidden.mjs [--enable links,linkifier]`, or point CDP_PORT at yours.')
}

// ── Attaching ───────────────────────────────────────────────────────────────

/** Every driver this process opened, so a failing run can still exit. */
const open = new Set()

function attachTo (target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
    let id = 0
    const pending = new Map()

    const ready = new Promise((resolve, reject) => {
        ws.on('open', resolve)
        ws.on('error', reject)
    })

    ws.on('message', data => {
        const message = JSON.parse(data.toString())
        if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message)
            pending.delete(message.id)
        }
    })

    // A request that is never answered and never settled is how a whole suite
    // came to sit alive for ever after one failure. Both ways out are covered:
    // the target going away, and it simply never replying.
    ws.on('close', () => {
        for (const resolve of pending.values()) {
            resolve({ gone: true })
        }
        pending.clear()
    })

    const send = (method, params = {}) => new Promise(resolve => {
        const messageId = ++id
        const timer = setTimeout(() => {
            pending.delete(messageId)
            console.error(`      cdp: ${method} (#${messageId}) went unanswered for ${REQUEST_MS}ms`)
            resolve({ timedOut: true })
        }, REQUEST_MS)
        pending.set(messageId, message => {
            clearTimeout(timer)
            resolve(message)
        })
        ws.send(JSON.stringify({ id: messageId, method, params }), () => { /* may already be closed */ })
    })

    const evaluate = async expression => {
        const result = await send('Runtime.evaluate', {
            expression: `(async () => { ${expression} })()`,
            awaitPromise: true,
            returnByValue: true,
        })
        if (result.result?.exceptionDetails) {
            throw new Error(result.result.exceptionDetails.exception?.description
                ?? JSON.stringify(result.result.exceptionDetails))
        }
        return result.result?.result?.value
    }

    const driver = {
        evaluate,
        send,
        target,
        port: target.__port,
        close: () => {
            open.delete(driver)
            ws.close()
        },
    }
    open.add(driver)
    return { driver, ready }
}

/** Close every socket this process opened. A failed run must still exit. */
function closeAll () {
    for (const driver of [...open]) {
        try {
            driver.close()
        } catch { /* already gone */ }
    }
    open.clear()
}

async function waitForTargets (port, count, filter, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let seen = 0
    let last = 'nothing was listening'
    for (;;) {
        try {
            // Asked every time round, not once: a port that was free before the
            // launch can be answered by something else by the time we look.
            await requireElectron(port)
            const found = (await fetchJson(port, '/json/list')).filter(filter)
            seen = found.length
            if (seen >= count) {
                return found.map(t => ({ ...t, __port: port }))
            }
        } catch (err) {
            // An instance that is still booting is worth waiting for. A port
            // that is answering as something *else* never becomes ours, and
            // waiting on it would only delay the refusal.
            if (err.message.includes('REFUSING TO ATTACH')) {
                throw err
            }
            last = err.message
        }
        if (Date.now() >= deadline) {
            throw new Error(seen
                ? `only ${seen} of ${count} renderer(s) on port ${port} after ${timeoutMs}ms`
                : `no renderer on port ${port} after ${timeoutMs}ms — ${last}`)
        }
        await new Promise(resolve => setTimeout(resolve, 500))
    }
}

/**
 * Attach to the hidden dev build.
 *
 * Returns one driver, or an array of `count` of them. Nothing is attached to
 * until the port has identified itself as Electron.
 */
async function connect ({ port, count = 1, filter = RENDERER, timeoutMs } = {}) {
    let chosen = port
    let source = 'the caller'
    if (!chosen) {
        const resolved = await resolvePort()
        chosen = resolved.port
        source = resolved.source
    }
    // A port that was discovered has already answered; one that was named may
    // belong to an instance that is still booting, so that one is waited on.
    const wait = timeoutMs ?? (source === 'the caller' || source === 'CDP_PORT' ? 30000 : 2000)
    const targets = await waitForTargets(chosen, count, filter, wait)

    const drivers = []
    for (const target of targets.slice(0, count)) {
        const { driver, ready } = attachTo(target)
        await ready
        drivers.push(driver)
    }
    return count === 1 ? drivers[0] : drivers
}

module.exports = {
    RANGE,
    RENDERER,
    attachTo,
    closeAll,
    connect,
    fetchJson,
    identify,
    isPortFree,
    liveInstances,
    pickPort,
    probe,
    registerInstance,
    requireElectron,
    resolvePort,
    unregisterInstance,
}
