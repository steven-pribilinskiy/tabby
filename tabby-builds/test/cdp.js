// Minimal CDP driver for the hidden dev build.
//
// A sibling of the other plugins' copies rather than a shared import: two
// builtin plugins must not depend on each other's test files.
const http = require('http')
const path = require('path')
const WebSocket = require(path.join(__dirname, '../../node_modules', 'ws'))

const PORT = parseInt(process.env.CDP_PORT ?? '9238', 10)

function get (urlPath) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: PORT, path: urlPath }, res => {
            let body = ''
            res.on('data', c => body += c)
            res.on('end', () => resolve(JSON.parse(body)))
        }).on('error', reject)
    })
}

async function connect () {
    const targets = await get('/json/list')
    const page = targets.find(t => t.type === 'page')
    if (!page) {
        throw new Error(`no page target on port ${PORT}`)
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
    await new Promise((resolve, reject) => {
        ws.on('open', resolve)
        ws.on('error', reject)
    })
    let id = 0
    const pending = new Map()
    ws.on('message', data => {
        const message = JSON.parse(data.toString())
        if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message)
            pending.delete(message.id)
        }
    })
    const send = (method, params = {}) => new Promise(resolve => {
        const messageId = ++id
        pending.set(messageId, resolve)
        ws.send(JSON.stringify({ id: messageId, method, params }))
    })
    const evaluate = async (expression) => {
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
    return { evaluate, send, close: () => ws.close(), port: PORT }
}

module.exports = { connect, PORT }
