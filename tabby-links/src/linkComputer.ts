/**
 * Buffer-window and string-index → buffer-position mapping, adapted from
 * `@xterm/addon-web-links`' `LinkComputer` (MIT, xterm.js authors).
 *
 * Two deliberate differences from the original:
 *
 * 1. **No `isUrl()` filter.** The upstream addon drops every match that does not
 *    parse as a URL (`new URL(text)` plus a prefix check). That is why Tabby's
 *    `UnixFileHandler`, `WindowsFileHandler` and `IPHandler` currently produce
 *    nothing clickable — a Windows path or a bare `10.0.0.1` never survives it.
 * 2. **Matching is the caller's job.** The original bakes one regex in; we run
 *    several patterns separately so we know *which* one matched, which is what
 *    a per-rule tooltip and `LinkHandler.priority` both need.
 *
 * The wrapped-line expansion and the wide-char index correction are kept
 * verbatim: they are subtle and getting them wrong drifts every range on CJK
 * output.
 */

import type { IBufferLine, Terminal } from '@xterm/xterm'

export interface BufferRange {
    start: { x: number, y: number }
    end: { x: number, y: number }
}

export interface LineWindow {
    /** The wrapped lines around `y`, joined. */
    text: string
    /** Buffer index of the first line in the window. */
    startLineIndex: number
}

/**
 * Get wrapped content lines for the current line index.
 * The top/bottom line expansion stops at whitespaces or length > 2048.
 *
 * NOTE: lines are pulled with trimRight=true on purpose, to correctly match
 * matches with early wrapped wide chars. That corrupts the string index for 1:1
 * backmapping to buffer positions, hence the correction in `mapStrIdx`.
 */
export function getLineWindow (terminal: Terminal, lineIndex: number): LineWindow {
    let line: IBufferLine | undefined = terminal.buffer.active.getLine(lineIndex)
    let topIdx = lineIndex
    let bottomIdx = lineIndex
    let length = 0
    let content = ''
    const lines: string[] = []

    if (line) {
        const currentContent = line.translateToString(true)

        // expand top, stop on whitespaces or length > 2048
        if (line.isWrapped && !currentContent.startsWith(' ')) {
            length = 0
            line = terminal.buffer.active.getLine(--topIdx)
            while (line && length < 2048) {
                content = line.translateToString(true)
                length += content.length
                lines.push(content)
                if (!line.isWrapped || content.includes(' ')) {
                    break
                }
                line = terminal.buffer.active.getLine(--topIdx)
            }
            lines.reverse()
        }

        lines.push(currentContent)

        // expand bottom, stop on whitespaces or length > 2048
        length = 0
        line = terminal.buffer.active.getLine(++bottomIdx)
        while (line?.isWrapped && length < 2048) {
            content = line.translateToString(true)
            length += content.length
            lines.push(content)
            if (content.includes(' ')) {
                break
            }
            line = terminal.buffer.active.getLine(++bottomIdx)
        }
    }

    return { text: lines.join(''), startLineIndex: topIdx }
}

/** Whether the line after `lineIndex` is wrapped and starts with a wide char. */
function wrapsIntoWideChar (terminal: Terminal, lineIndex: number): boolean {
    const next = terminal.buffer.active.getLine(lineIndex + 1)
    if (!next?.isWrapped) {
        return false
    }
    const cell = terminal.buffer.active.getNullCell()
    next.getCell(0, cell)
    return cell.getWidth() === 2
}

/**
 * Map a string index back to a buffer position.
 * Returns [lineIndex, columnIndex] 0-based, or [-1, -1] if the lookup ran off
 * the end of the buffer.
 */
export function mapStrIdx (
    terminal: Terminal,
    lineIndex: number,
    rowIndex: number,
    stringIndex: number,
): [number, number] {
    const buf = terminal.buffer.active
    const cell = buf.getNullCell()
    let start = rowIndex
    while (stringIndex) {
        const line = buf.getLine(lineIndex)
        if (!line) {
            return [-1, -1]
        }
        for (let i = start; i < line.length; ++i) {
            line.getCell(i, cell)
            const chars = cell.getChars()
            const width = cell.getWidth()
            if (width) {
                stringIndex -= chars.length || 1

                // Correct for early-wrapped wide chars:
                // - only happens at the last cell
                // - cells to the right are reset with chars='' and width=1 in InputHandler.print
                // --> if the follow-up line is wrapped and starts with a wide char, correct by +1
                if (i === line.length - 1 && chars === '' && wrapsIntoWideChar(terminal, lineIndex)) {
                    stringIndex += 1
                }
            }
            if (stringIndex < 0) {
                return [lineIndex, i]
            }
        }
        lineIndex++
        start = 0
    }
    return [lineIndex, start]
}

/**
 * Turn a match's position within a line window into a buffer range, in xterm's
 * convention: 1-based, right side inclusive except for `end.x`.
 */
export function rangeFor (
    terminal: Terminal,
    startLineIndex: number,
    matchIndex: number,
    textLength: number,
): BufferRange | null {
    const [startY, startX] = mapStrIdx(terminal, startLineIndex, 0, matchIndex)
    if (startY === -1 || startX === -1) {
        return null
    }
    const [endY, endX] = mapStrIdx(terminal, startY, startX, textLength)
    if (endY === -1 || endX === -1) {
        return null
    }
    return {
        start: { x: startX + 1, y: startY + 1 },
        end: { x: endX, y: endY + 1 },
    }
}
