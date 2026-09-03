/**
 * Time-boxed regular expressions.
 *
 * Rule patterns are authored by hand and matched, synchronously, on xterm's
 * mousemove handler against text a *remote host* printed. That combination is a
 * remotely triggerable freeze: measured in this build, `(a+)+b` against thirty
 * `a`s takes 11.8 seconds, and nothing about the terminal is usable while it
 * runs. `app/lib/diagnostics.ts` would faithfully record the stall; the point
 * here is for there not to be one.
 *
 * A JS regex cannot be interrupted once started, so the defence is three cheap
 * layers rather than one perfect one:
 *
 * 1. **Cap the input.** Backtracking blowup scales with input length, so a
 *    bounded window bounds the worst case.
 * 2. **Notice and disable.** Time each run; a pattern that blows the budget is
 *    switched off for the session and named in a notification. It can hang the
 *    UI once, never twice.
 * 3. **Smoke-test on save.** The settings page runs a candidate pattern against
 *    adversarial strings before storing it, which catches the usual mistakes
 *    before they ever reach a terminal.
 *
 * Note that the four built-in `LinkHandler` regexes look dangerous (nested
 * quantifiers) and measure fine — `/[~]?(\/[\w\d.~-]{1,100})+/` is 0.04 ms on
 * 4000 chars, because the inner class excludes `/` and so each iteration has an
 * unambiguous anchor. A static "reject nested quantifiers" check would refuse
 * Tabby's own defaults, which is why this measures instead.
 */

/** Longest text a text-kind rule is offered. Well below the ~4 KB line window. */
export const MAX_TEXT_INPUT = 512

/** A single match may take this long before the pattern is considered broken. */
export const MATCH_BUDGET_MS = 20

/**
 * Shapes that make a backtracking engine work, probed at increasing lengths.
 *
 * Length matters more than variety: catastrophic patterns are exponential in
 * the input, so the probe walks up from very short strings and stops the moment
 * a run is slow enough to be suspicious. Probing a fixed long string instead is
 * how the first version of this check took **127 seconds** on `(a+)+b` — it
 * detected the freeze by reproducing it, in the settings page, on every
 * keystroke.
 */
const PROBE_SHAPES = [
    (n: number) => `${'a'.repeat(n)}!`,
    (n: number) => `${'ab'.repeat(Math.ceil(n / 2))}!`,
    (n: number) => `${'/a'.repeat(Math.ceil(n / 2))}!`,
    (n: number) => `${'0'.repeat(n)}x`,
    (n: number) => `https://example.com/${'a/'.repeat(Math.ceil(n / 2))}`,
]

const PROBE_LENGTHS = [6, 10, 14, 18, 22]

/**
 * A run at one probe length that takes longer than this is treated as proof of
 * superlinear growth and the escalation stops there. A well-behaved pattern is
 * microseconds on a 22-character string, so this is not a close call.
 */
const PROBE_SUSPICIOUS_MS = 4

export interface RegexGuardHost {
    /** Called once, when a pattern is disabled for the session. */
    onDisabled: (label: string, elapsedMs: number) => void
}

/**
 * A compiled pattern that stops being used once it has proven to be too slow.
 */
export class GuardedRegex {
    readonly ok: boolean
    readonly error: string = ''
    private regex: RegExp | null = null
    private anchored: RegExp | null = null
    private disabled = false

    constructor (
        source: string,
        flags: string,
        private label: string,
        private host: RegexGuardHost | null = null,
    ) {
        // Checked here, not only when a rule is saved: a rule written straight
        // into `config.yaml` never passes through the settings page, and this is
        // the one place every pattern must go through before it can run against
        // terminal output.
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        const check = checkPattern(source, flags)
        if (!check.ok) {
            // A pattern that will not compile, or that is dangerously slow,
            // matches nothing. It must never throw out of a hover, and must
            // never be treated as "matches everything" — both are worse than
            // being ignored.
            this.ok = false
            this.error = check.error
            return
        }
        try {
            this.regex = new RegExp(source, flags)
            this.ok = true
        } catch (err) {
            this.ok = false
            this.error = `${err}`
        }
    }

    get usable (): boolean {
        return this.ok && !this.disabled && !!this.regex
    }

    /** All matches in `text`, or `[]` if the pattern is unusable. */
    execAll (text: string, limit = 32): RegExpExecArray[] {
        if (!this.usable) {
            return []
        }
        const regex = this.regex!
        regex.lastIndex = 0
        const out: RegExpExecArray[] = []
        const started = performance.now()
        let match: RegExpExecArray | null = regex.exec(text)
        while (match) {
            out.push(match)
            // Without /g, `exec` never advances `lastIndex` and would return the
            // same match forever.
            if (!regex.global) {
                break
            }
            // A zero-length match would spin forever otherwise.
            if (match[0].length === 0) {
                regex.lastIndex++
            }
            if (out.length >= limit) {
                break
            }
            if (performance.now() - started > MATCH_BUDGET_MS) {
                break
            }
            match = regex.exec(text)
        }
        const elapsed = performance.now() - started
        if (elapsed > MATCH_BUDGET_MS) {
            this.disable(elapsed)
        }
        return out
    }

    /** Whether `text` matches in its entirety. */
    fullMatch (text: string): boolean {
        if (!this.usable) {
            return false
        }
        if (!this.anchored) {
            try {
                this.anchored = new RegExp(`^(?:${this.regex!.source})$`, this.regex!.flags.replace('g', ''))
            } catch {
                return false
            }
        }
        const started = performance.now()
        let result = false
        try {
            result = this.anchored.test(text)
        } catch {
            result = false
        }
        const elapsed = performance.now() - started
        if (elapsed > MATCH_BUDGET_MS) {
            this.disable(elapsed)
            return false
        }
        return result
    }

    private disable (elapsedMs: number): void {
        if (this.disabled) {
            return
        }
        this.disabled = true
        this.host?.onDisabled(this.label, elapsedMs)
    }
}

export interface PatternCheck {
    ok: boolean
    /** Empty when ok; otherwise why the pattern was refused. */
    error: string
}

function tooSlow (elapsedMs: number, length: number): string {
    return `too slow — ${elapsedMs.toFixed(1)} ms on only ${length} characters, `
        + 'which grows explosively with longer input. A pattern like this can freeze '
        + 'the window on output a remote host controls.'
}

/**
 * Does this pattern compile, and does it stay fast on inputs designed to make a
 * backtracking engine explode?
 *
 * The probe escalates from 6 characters to 22 and stops at the first length
 * that is even slightly slow, so the check itself is bounded no matter how bad
 * the pattern is: an exponential pattern is refused at a length where it still
 * costs milliseconds, long before the length where it would cost minutes.
 *
 * Run both when a pattern is saved and when it is compiled, so a rule
 * hand-written into `config.yaml` is checked too.
 */
export function checkPattern (source: string, flags = ''): PatternCheck {
    let regex = /(?:)/
    try {
        regex = new RegExp(source, flags)
    } catch (err) {
        return { ok: false, error: `${err}`.replace(/^\w*Error: /, '') }
    }
    for (const length of PROBE_LENGTHS) {
        let slowest = 0
        for (const shape of PROBE_SHAPES) {
            const input = shape(length)
            const started = performance.now()
            try {
                regex.lastIndex = 0
                regex.exec(input)
            } catch {
                // A throwing pattern is a refusing pattern.
                return { ok: false, error: 'the pattern threw while matching' }
            }
            const elapsed = performance.now() - started
            slowest = Math.max(slowest, elapsed)
            if (elapsed > MATCH_BUDGET_MS) {
                return { ok: false, error: tooSlow(elapsed, input.length) }
            }
        }
        // Slow already at this length means the next one is far worse. Refuse
        // here rather than measuring it.
        if (slowest > PROBE_SUSPICIOUS_MS) {
            return { ok: false, error: tooSlow(slowest, length) }
        }
    }
    return { ok: true, error: '' }
}

