/**
 * The `html` card representation: a plugin's own HTML document, rendered in
 * place of the field list.
 *
 * The contract is the Windows Terminal fork's, and matching it exactly is the
 * point — a manifest is meant to be portable between terminals. There, the
 * document is handed to a WebView2 (`HyperlinkHtmlHost.cpp`); here the renderer
 * is already Chromium, so it is an `<iframe srcdoc>`. Either way the page sees:
 *
 * - `window.__data` — every fetch step's JSON, keyed by step id
 * - `window.__uri`  — the URI or text that was hovered
 * - `chrome.webview.postMessage({ height })` / `({ open })` to talk back
 *
 * That last one is why the shim below exists. `chrome.webview` is a WebView2
 * API; without providing it under that name, every `html` manifest would have
 * to branch on which terminal it was running in, and the format would stop
 * being portable at exactly the point it started being useful.
 *
 * Everything here is a pure string function so it can be exercised without a
 * running app — see `test/htmlHost.test.js`.
 */

/** A card is a hover affordance. A plugin asking for 1000px does not get the pane. */
export const HTML_MIN_HEIGHT = 40
export const HTML_MAX_HEIGHT = 320
/** What the frame gets before the page has measured itself. */
export const HTML_DEFAULT_HEIGHT = 120
export const HTML_MIN_WIDTH = 240

/**
 * The sandbox, in one place because it is the entire security story.
 *
 * `allow-scripts` is required — the page has to read `__data` and report its
 * height. It is also the *only* token: adding `allow-same-origin` would give the
 * frame this window's `file://` origin, and since Tabby's renderer runs with
 * `nodeIntegration: true` and `contextIsolation: false`, a plugin's page would
 * then be one `window.parent.require('child_process')` from arbitrary code.
 * With `allow-scripts` alone the frame has an opaque origin: it can post a
 * message to us and nothing else.
 *
 * Everything else stays off by omission — popups, forms, modals, downloads,
 * pointer lock, and top-level navigation. That covers most of what the WebView2
 * host has to switch off by hand.
 *
 * The template writes this value out literally rather than binding it: Angular
 * rejects a bound `sandbox` (NG0910), and is right to, since a sandbox that can
 * be reassigned at runtime is not one. This constant exists so a test can
 * assert the two have not drifted apart.
 */
export const HTML_SANDBOX = 'allow-scripts'

/**
 * No network. The page renders data the fetch pipeline already retrieved, so it
 * has no business calling out, and `window.__data` can hold remote content — a
 * Jira summary, a Slack message body.
 *
 * `img-src https:` is the one exception, and only for parity: the field list
 * already loads remote icons through `iconPath`, so forbidding them here would
 * make the two representations disagree about what a manifest may show. It is
 * the single remaining egress channel and is documented as such.
 *
 * The WebView2 host sets no CSP at all; this is a hardening the standard should
 * pick up rather than a divergence.
 */
const NONE = '\'none\''
export const HTML_CSP = [
    `default-src ${NONE}`,
    'script-src \'unsafe-inline\'',
    'style-src \'unsafe-inline\'',
    'img-src https: data:',
    'font-src data:',
    `connect-src ${NONE}`,
    `form-action ${NONE}`,
    `base-uri ${NONE}`,
].join('; ')

/**
 * A JSON literal safe to paste into a `<script>`.
 *
 * `JSON.stringify` alone is not enough: the hovered URI is text a remote host
 * printed, and `</script` inside a string literal ends the element no matter
 * what the JSON says. Escaping `<` costs nothing and closes that, along with
 * `<!--`, which HTML treats specially inside a script. The WebView2 host reaches
 * the same guarantee by round-tripping through its JSON parser
 * (`HyperlinkHtmlHost.cpp:55-85`).
 *
 * Anything that will not serialise becomes `null` rather than becoming code.
 */
export function jsonLiteral (value: unknown): string {
    let text = 'null'
    try {
        text = JSON.stringify(value ?? null)
    } catch {
        // Circular, a BigInt, a throwing getter — none of which a fetch step
        // should produce, but a `command` step's output is whatever it is.
        text = 'null'
    }
    // U+2028/9 terminate a line for a JS parser but not for JSON's, so a
    // string carrying one would break the bootstrap it is embedded in.
    return text
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
}

/** The bootstrap, injected ahead of every script the page brought with it. */
function bootstrap (data: Record<string, any>, uri: string): string {
    return '<script>'
        + `window.__data=${jsonLiteral(data)};`
        + `window.__uri=${jsonLiteral(uri)};`
        + 'window.chrome=window.chrome||{};'
        + 'window.chrome.webview={postMessage:function(m){parent.postMessage(m,"*")}};'
        + '</script>'
}

/**
 * Where our CSP and bootstrap have to go: before anything the page can run or
 * load. Returns the index to splice at.
 *
 * A `<head>` is preferred because that is where a meta CSP is honoured. Failing
 * that, straight after `<html …>`, and failing that after a leading doctype —
 * the parser will hoist a leading `<meta>` into the head it synthesises. A
 * comment or whitespace before the doctype is fine; it is not content.
 */
function injectionPoint (document: string): number {
    const head = /<head\b[^>]*>/i.exec(document)
    if (head) {
        return head.index + head[0].length
    }
    const html = /<html\b[^>]*>/i.exec(document)
    if (html) {
        return html.index + html[0].length
    }
    const doctype = /<!doctype\b[^>]*>/i.exec(document)
    if (doctype) {
        return doctype.index + doctype[0].length
    }
    return 0
}

/**
 * The complete `srcdoc` for a manifest's document: its own markup, with the CSP
 * and the bootstrap spliced in ahead of anything it can execute.
 */
export function buildHtmlDocument (html: string, data: Record<string, any>, uri: string): string {
    const injected = `<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">`
        + bootstrap(data, uri)
    const at = injectionPoint(html)
    return html.slice(0, at) + injected + html.slice(at)
}

/**
 * A height a page asked for, clamped — or null when it did not ask for one we
 * can use. `postMessage` carries whatever the page felt like sending, so a
 * string, a NaN and a negative all have to be survivable.
 */
export function clampHtmlHeight (value: unknown): number | null {
    // A string is accepted because a page may well send `"120"`; a boolean is
    // not, because `Number(true)` is 1 and that would silently become a card.
    if (typeof value !== 'number' && typeof value !== 'string') {
        return null
    }
    const height = Number(value)
    if (!Number.isFinite(height) || height <= 0) {
        return null
    }
    return Math.min(HTML_MAX_HEIGHT, Math.max(HTML_MIN_HEIGHT, Math.round(height)))
}

/** What a page sent us, if it is one of the two messages in the contract. */
export interface HtmlHostMessage {
    height?: number
    open?: string
}

/**
 * Read a `postMessage` payload against the contract. WebView2 delivers
 * `postMessage(object)` as JSON and `postMessage(string)` as a string, so both
 * shapes are accepted here too.
 */
export function parseHtmlHostMessage (raw: unknown): HtmlHostMessage | null {
    let value = raw
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value)
        } catch {
            return null
        }
    }
    if (!value || typeof value !== 'object') {
        return null
    }
    const fields = value as Record<string, unknown>
    const message: HtmlHostMessage = {}
    const height = clampHtmlHeight(fields.height)
    if (height !== null) {
        message.height = height
    }
    if (typeof fields.open === 'string' && fields.open) {
        message.open = fields.open
    }
    return message.height === undefined && message.open === undefined ? null : message
}
