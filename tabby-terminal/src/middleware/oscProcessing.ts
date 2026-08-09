import * as os from 'os'
import { Subject, Observable } from 'rxjs'
import { SessionMiddleware } from '../api/middleware'

const OSCPrefix = Buffer.from('\x1b]')
const OSCSuffixes = [Buffer.from('\x07'), Buffer.from('\x1b\\')]

export class OSCProcessor extends SessionMiddleware {
    get cwdReported$ (): Observable<string> { return this.cwdReported }
    get copyRequested$ (): Observable<string> { return this.copyRequested }

    private cwdReported = new Subject<string>()
    private buffer: Buffer | null = null
    private copyRequested = new Subject<string>()

    feedFromSession (data: Buffer): void {
        // Prepend any buffered data from previous chunks
        if (this.buffer) {
            data = Buffer.concat([this.buffer, data])
            this.buffer = null
        }

        let startIndex = 0
        const processedData: Buffer[] = []

        while (startIndex < data.length) {
            const prefixIndex = data.indexOf(OSCPrefix, startIndex)

            if (prefixIndex === -1) {
                // No more OSC sequences, pass remaining data
                if (startIndex < data.length) {
                    processedData.push(data.subarray(startIndex))
                }
                break
            }

            // Pass data before this OSC sequence
            if (prefixIndex > startIndex) {
                processedData.push(data.subarray(startIndex, prefixIndex))
            }

            // Look for suffix after the prefix
            const suffixSearchStart = prefixIndex + OSCPrefix.length
            let foundSuffix: [Buffer, number] | null = null

            for (const suffix of OSCSuffixes) {
                const suffixIndex = data.indexOf(suffix, suffixSearchStart)
                if (suffixIndex !== -1) {
                    if (!foundSuffix || suffixIndex < foundSuffix[1]) {
                        foundSuffix = [suffix, suffixIndex]
                    }
                }
            }

            if (!foundSuffix) {
                // No suffix found - buffer the rest and wait for next chunk
                this.buffer = data.subarray(prefixIndex)
                break
            }

            // Extract OSC string (between prefix and suffix)
            const oscString = data.subarray(suffixSearchStart, foundSuffix[1]).toString()
            const [oscCodeString, ...oscParams] = oscString.split(';')
            const oscCode = parseInt(oscCodeString)

            if (oscCode === 7) {
                // OSC 7 — `file://<host><path>`, the de-facto standard CWD report.
                // Default bash/zsh setups (including WSL's) emit this and not the
                // iTerm 1337 variant below, so without it a WSL tab never reports
                // a working directory at all.
                const cwd = this.parseOSC7(oscParams.join(';'))
                if (cwd) {
                    this.cwdReported.next(cwd)
                }
                // Passed through rather than swallowed: OSC 7 is purely
                // informational and frontends/addons may also consume it, so
                // dropping it here could regress something downstream. (OSC 1337
                // is swallowed because it is Tabby-specific and noisy if printed.)
                processedData.push(data.subarray(prefixIndex, foundSuffix[1] + foundSuffix[0].length))
            } else if (oscCode === 1337) {
                const paramString = oscParams.join(';')
                if (paramString.startsWith('CurrentDir=')) {
                    let reportedCWD = paramString.split('=', 2)[1]
                    if (reportedCWD.startsWith('~')) {
                        reportedCWD = os.homedir() + reportedCWD.substring(1)
                    }
                    this.cwdReported.next(reportedCWD)
                } else {
                    console.debug('Unsupported OSC 1337 parameter:', paramString)
                }
            } else if (oscCode === 52) {
                if (oscParams[0] === 'c' || oscParams[0] === '') {
                    const content = Buffer.from(oscParams[1], 'base64')
                    this.copyRequested.next(content.toString())
                }
            } else {
                processedData.push(data.subarray(prefixIndex, foundSuffix[1] + foundSuffix[0].length))
            }

            // Move past this OSC sequence
            startIndex = foundSuffix[1] + foundSuffix[0].length
        }

        // Pass through all processed data
        if (processedData.length > 0) {
            super.feedFromSession(Buffer.concat(processedData))
        }
    }

    close (): void {
        this.cwdReported.complete()
        this.copyRequested.complete()
        super.close()
    }

    /**
     * `file://<host><path>` → `<path>`. The host is whatever the shell decided
     * to call the machine and is not comparable to anything we know, so it is
     * discarded; only the path is meaningful. Returns null for anything that
     * isn't a well-formed file URL, so a malformed report is ignored rather
     * than overwriting a good CWD with garbage.
     */
    private parseOSC7 (param: string): string | null {
        if (!param.startsWith('file://')) {
            return null
        }
        // Skip the authority; the path starts at the first `/` after it.
        const pathStart = param.indexOf('/', 'file://'.length)
        if (pathStart === -1) {
            return null
        }
        let path = param.substring(pathStart)
        try {
            path = decodeURIComponent(path)
        } catch {
            // Malformed %-escape — a raw path is still more useful than nothing.
        }
        // Windows reports `/C:/Users/…`; strip the leading slash so the value
        // matches what every other Windows API in Tabby produces.
        if (/^\/[a-zA-Z]:[/\\]/.test(path)) {
            path = path.substring(1)
        }
        return path || null
    }
}
