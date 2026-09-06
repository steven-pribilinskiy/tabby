// The attach path refuses anything that is not an Electron debugger.
//
//   node scripts/dev/cdp.test.cjs
//
// Plain node, nothing launched. The decoys are HTTP servers this process owns,
// on ports the OS hands out — a real browser is never probed, let alone
// attached to, which is the whole point of the thing under test.
//
// It is worth asserting because the failure it prevents is silent and was real:
// Chromium does not report a `--remote-debugging-port` it could not bind, so a
// test that hardcoded 9251 attached to the user's own Chrome and would have
// evaluated JavaScript in its logged-in tabs. Only a URL filter stopped it.
const http = require('http')
const path = require('path')

const cdp = require(path.join(__dirname, 'cdp.cjs'))

let failed = 0

function check (ok, message) {
    console.log(`${ok ? 'ok   ' : 'FAIL '} ${message}`)
    if (!ok) {
        failed++
    }
}

function serve (handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler)
        server.listen(0, '127.0.0.1', () =>
            resolve({ port: server.address().port, close: () => server.close() }))
    })
}

/** Verbatim in shape from a real Chrome, which is what makes it a fair decoy. */
const CHROME = JSON.stringify({
    Browser: 'Chrome/141.0.7390.55',
    'Protocol-Version': '1.3',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        + ' (KHTML, like Gecko) Chrome/141.0.7390.55 Safari/537.36',
    'V8-Version': '14.1.99',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/decoy',
})

async function refuses (port, wanted, what) {
    try {
        await cdp.requireElectron(port)
        check(false, `${what} was ACCEPTED`)
    } catch (err) {
        check(err.message.includes(wanted), `${what} is refused — ${err.message.split('\n')[0].slice(0, 110)}`)
    }
}

async function main () {
    // A browser. The one that actually happened.
    const chrome = await serve((req, res) => {
        res.end(req.url === '/json/version' ? CHROME : '[]')
    })
    await refuses(chrome.port, 'REFUSING TO ATTACH', 'an endpoint calling itself Chrome')
    check(await cdp.probe(chrome.port) === null, 'and discovery never offers it as a candidate')
    try {
        await cdp.connect({ port: chrome.port, timeoutMs: 3000 })
        check(false, 'connect() attached to the decoy anyway')
    } catch (err) {
        check(err.message.includes('REFUSING TO ATTACH'),
            'connect() refuses it before opening a socket, rather than waiting out its timeout')
    }

    // Something on the port that is not a debugger at all.
    const junk = await serve((_, res) => res.end('<html>not a debugger</html>'))
    await refuses(junk.port, 'not JSON', 'an endpoint answering HTML')

    // 9223/9224 answer LISTENING because svchost forwards them from WSL, and
    // then never reply. A probe that waits on the OS holds up the whole suite.
    const silent = await serve(() => { /* deliberately no response */ })
    const started = Date.now()
    await refuses(silent.port, 'did not answer', 'an endpoint that accepts and then says nothing')
    check(Date.now() - started < 4000, `and gives up in ${Date.now() - started}ms rather than hanging`)

    const dead = await serve(() => {})
    const deadPort = dead.port
    dead.close()
    await new Promise(resolve => setTimeout(resolve, 200))
    await refuses(deadPort, 'refusing to attach', 'a port with nothing on it')

    // A free port is a port nothing else holds — which is necessary, and on its
    // own not sufficient, hence everything above.
    const taken = await serve(() => {})
    const picked = await cdp.pickPort({ preferred: taken.port })
    check(picked !== taken.port && await cdp.isPortFree(picked),
        `pickPort passed over the occupied ${taken.port} for the free ${picked}`)
    check(await cdp.pickPort({ preferred: picked }) === picked, 'and keeps a preferred port that is free')

    for (const server of [chrome, junk, silent, taken]) {
        server.close()
    }
    cdp.closeAll()
}

main().catch(err => {
    console.error('FAIL  the test itself threw:', err)
    failed++
}).finally(() => {
    cdp.closeAll()
    console.log(failed ? `\n${failed} failed` : '\nall good')
    process.exitCode = failed ? 1 : 0
})
