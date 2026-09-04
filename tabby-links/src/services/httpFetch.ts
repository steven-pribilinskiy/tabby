/**
 * HTTP for integration fetch steps, on Node rather than the renderer's `fetch`.
 *
 * Three reasons, in order of how much they hurt:
 *
 * 1. **Certificates.** A step may opt into an untrusted certificate
 *    (`allowUntrustedCertificate`), which the stith manifest needs for a
 *    self-signed `lvh.me` cert. `fetch` has no such escape hatch.
 * 2. **Timeouts.** A step's `timeoutMs` has to bound the whole exchange —
 *    connect, response, and body — not just the headers.
 * 3. **Origin.** The renderer is a `file://` page, so a cross-origin request
 *    carries `Origin: null`. Endpoints that send permissive CORS headers (npm,
 *    say) work either way, but Jira and Slack do not, and an integration is
 *    supposed to be able to talk to anything.
 */

export interface HttpRequest {
    url: string
    method: string
    headers: Record<string, string>
    body?: string
    timeoutMs: number
    allowUntrustedCertificate?: boolean
}

export interface HttpResponse {
    status: number
    statusText: string
    body: string
}

const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_REDIRECTS = 5

interface RawResponse extends HttpResponse {
    redirectTo?: string
}

function once (request: HttpRequest, url: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        let parsed: URL = new URL('http://invalid.invalid')
        try {
            parsed = new URL(url)
        } catch {
            reject(new Error('the step has no usable URL'))
            return
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            reject(new Error(`unsupported scheme ${parsed.protocol.replace(':', '')}`))
            return
        }

        const transport = parsed.protocol === 'https:' ? require('https') : require('http')
        const timeoutMs = request.timeoutMs > 0 ? request.timeoutMs : 8000
        let settled = false

        // `timer` is assigned below and only ever read from a callback that
        // cannot run before then.
        const finish = (fn: () => void) => {
            if (settled) {
                return
            }
            settled = true
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            clearTimeout(timer)
            fn()
        }

        const req = transport.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || undefined,
            path: `${parsed.pathname}${parsed.search}`,
            method: request.method || 'GET',
            headers: { 'user-agent': 'Tabby', ...request.headers },
            // Only ever relaxes chain validation, and only for a step that asked.
            rejectUnauthorized: !request.allowUntrustedCertificate,
        }, (res: any) => {
            const chunks: Buffer[] = []
            let size = 0
            res.on('data', (chunk: Buffer) => {
                size += chunk.length
                if (size > MAX_BODY_BYTES) {
                    res.destroy()
                    finish(() => reject(new Error('the response was too large')))
                    return
                }
                chunks.push(chunk)
            })
            res.on('end', () => finish(() => {
                const status = res.statusCode ?? 0
                const location = res.headers?.location
                resolve({
                    status,
                    statusText: res.statusMessage ?? '',
                    body: Buffer.concat(chunks).toString('utf8'),
                    redirectTo: status >= 300 && status < 400 && location ? String(location) : undefined,
                })
            }))
            res.on('error', (err: Error) => finish(() => reject(err)))
        })

        const timer = setTimeout(() => {
            req.destroy()
            finish(() => reject(new Error('timed out')))
        }, timeoutMs)

        req.on('error', (err: Error) => finish(() => reject(err)))
        if (request.body) {
            req.write(request.body)
        }
        req.end()
    })
}

async function follow (request: HttpRequest, url: string, redirectsLeft: number): Promise<HttpResponse> {
    const response = await once(request, url)
    const location = response.redirectTo
    if (location && redirectsLeft > 0) {
        return follow(request, new URL(location, url).toString(), redirectsLeft - 1)
    }
    return response
}

export interface CommandResult {
    stdout: string
    /**
     * Kept apart from stdout, because a step's contract is "parse stdout as
     * JSON" and plenty of well-behaved commands write a warning to stderr on
     * the way to a perfectly good result. Merging them made every such command
     * fail to parse, reporting "produced no usable output" about output that
     * was fine. Surfaced only when there is nothing to parse.
     */
    stderr: string
}

/** Run a local command and capture its output, bounded by the same timeout. */
export async function httpRequest (request: HttpRequest): Promise<HttpResponse> {
    return follow(request, request.url, MAX_REDIRECTS)
}

export function runCommand (commandLine: string, stdin: string, timeoutMs: number): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        const { spawn } = require('child_process')
        const child = spawn(commandLine, {
            shell: true,
            windowsHide: true,
        })
        const chunks: Buffer[] = []
        const errorChunks: Buffer[] = []
        let size = 0
        let settled = false
        // `timer` is assigned below and only ever read from a callback that
        // cannot run before then.
        const finish = (fn: () => void) => {
            if (settled) {
                return
            }
            settled = true
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            clearTimeout(timer)
            fn()
        }
        const timer = setTimeout(() => {
            child.kill()
            finish(() => reject(new Error('timed out')))
        }, timeoutMs > 0 ? timeoutMs : 8000)

        // Both streams count against the same cap — the limit is on how much a
        // step may produce, not on which pipe it chose.
        const collect = (into: Buffer[]) => (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
                child.kill()
                finish(() => reject(new Error('the command produced too much output')))
                return
            }
            into.push(chunk)
        }
        child.stdout?.on('data', collect(chunks))
        child.stderr?.on('data', collect(errorChunks))
        child.on('error', (err: Error) => finish(() => reject(err)))
        child.on('close', () => finish(() => resolve({
            stdout: Buffer.concat(chunks).toString('utf8'),
            stderr: Buffer.concat(errorChunks).toString('utf8'),
        })))

        if (stdin) {
            child.stdin?.write(stdin)
        }
        child.stdin?.end()
    })
}
