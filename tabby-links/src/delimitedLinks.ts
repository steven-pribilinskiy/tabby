/**
 * Slack-style delimited links: `<https://github.com/o/r/pull/9962|repo#9962>`.
 *
 * Slack, and every CLI that formats a message for it, writes links this way, and
 * that text lands in the terminal verbatim whenever you paste it or a tool echoes
 * it back. Tabby's bare-URI handler stops at the pipe — `|` is not in any of its
 * character classes — so the URI it hands the opener is correct. What is missing
 * is everything around it: the brackets and the label are part of no link at all,
 * so the part you actually aim at, `repo#9962`, is not hoverable and not
 * clickable, and the underline covers only the URI in the middle.
 *
 * Matching the whole construct fixes that. The URI is still *shown* in full —
 * this makes the construct clickable, it does not collapse it to the label.
 * Rendering the label alone would mean the renderer showing text the buffer does
 * not hold, which selection, copy, search and reflow all depend on; a program
 * that wants the collapsed form should emit OSC 8.
 *
 * Ported from the Windows Terminal fork's `c2dd09a42`, which does the same thing
 * with a second ICU pattern and a pattern id in the interval tree. Here the
 * equivalent of "prefer the delimited match over the bare-URI match nested inside
 * it" is the priority below, because `decorator.ts` already resolves overlapping
 * matches by priority — only the delimited match knows where the URI stops and
 * the label begins, and only it covers the label.
 */

/**
 * Above every `LinkHandler` (`URLHandler` is the highest at 5), so the bare-URI
 * match nested inside the construct loses its cells and the whole thing reads as
 * one link. Deliberately *equal* to the text-rule tier rather than above it:
 * text rules are scanned first and ties go to the earlier claim, so a rule the
 * user wrote for something in the label still wins — exactly as it already wins
 * over a bare URL.
 */
export const DELIMITED_LINK_PRIORITY = 100

/**
 * `<scheme://uri>` with an optional `|label` suffix.
 *
 * Exported as a source string so a test can compile its own copy without
 * inheriting `lastIndex` from the scanner below.
 *
 * This runs synchronously on xterm's mousemove handler against text a remote
 * host printed, so it is linear by construction rather than by measurement:
 *
 * - the scheme is bounded (`{1,15}`) and must be followed by `://`;
 * - the URI class excludes whitespace, both brackets and the pipe, so its `+`
 *   has an unambiguous end and cannot overlap the parts after it;
 * - the label class excludes both brackets, so it cannot run past the closing
 *   one, and is capped at 256 anyway;
 * - the only optional group starts with a literal `|`, so backtracking the URI
 *   fails it immediately instead of re-scanning.
 *
 * Worst case is one backtracking pass per candidate `<`, and a candidate cannot
 * start inside another's URI because `<` is excluded from that class. `\n` is in
 * the label's exclusion set for parity with the reference; the line window this
 * is scanned against is already joined without newlines.
 */
export const DELIMITED_LINK_SOURCE = String.raw`<[A-Za-z][A-Za-z0-9+.\-]{1,15}://[^\s<>|]+(?:\|[^<>\n]{0,256})?>`

const scanner = new RegExp(DELIMITED_LINK_SOURCE, 'g')

export interface DelimitedLink {
    /** Index of the opening `<` in the scanned text. */
    index: number
    /** The whole construct, brackets and label included — what gets underlined. */
    text: string
    /** What it points at: everything between `<` and the first `|` or the `>`. */
    uri: string
}

/**
 * Strip the brackets and the optional `|label` suffix, leaving just the URI:
 *
 *     <https://example.com/pull/1|repo#1>  ->  https://example.com/pull/1
 *     <https://example.com/pull/1>         ->  https://example.com/pull/1
 */
export function uriFromDelimitedLink (match: string): string {
    let uri = match
    if (uri.startsWith('<')) {
        uri = uri.slice(1)
    }
    if (uri.endsWith('>')) {
        uri = uri.slice(0, -1)
    }
    const pipe = uri.indexOf('|')
    return pipe < 0 ? uri : uri.slice(0, pipe)
}

/**
 * Every delimited link in `text`, in order.
 *
 * `limit` matches the cap the handler scan next to it uses; a row with more than
 * this many links on it is output, not something anyone is pointing at. No
 * zero-length guard is needed — the pattern cannot match fewer than seven
 * characters — but `lastIndex` is reset because the scanner is shared.
 */
export function findDelimitedLinks (text: string, limit = 64): DelimitedLink[] {
    const out: DelimitedLink[] = []
    scanner.lastIndex = 0
    let match: RegExpExecArray | null = scanner.exec(text)
    while (match && out.length < limit) {
        out.push({
            index: match.index,
            text: match[0],
            uri: uriFromDelimitedLink(match[0]),
        })
        match = scanner.exec(text)
    }
    return out
}
