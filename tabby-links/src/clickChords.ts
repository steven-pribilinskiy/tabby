/**
 * Click chords: which mouse gesture, held with which modifiers, activates a
 * link — and which of the two configurable chords a given press matches.
 *
 * Deliberately pure and free of Angular, so `test/logic.test.js` can measure it
 * directly. What a click does is easy to get subtly wrong and hard to notice,
 * because the wrong answer is almost always "nothing happened".
 *
 * The vocabulary is the Windows Terminal fork's, so a chord reads the same in
 * both — except that the Windows key is spelled `meta` rather than `win`,
 * because on macOS it is Cmd. `win` is accepted as an alias so a settings
 * snippet copied from that fork still works.
 */

export type ClickModifier =
    'none' | 'ctrl' | 'alt' | 'shift' | 'meta' |
    'ctrlAlt' | 'ctrlShift' | 'altShift' | 'ctrlAltShift'

/**
 * Which mouse gesture activates a link. Right click is deliberately absent: it
 * belongs to the context menu and to paste.
 */
export type ClickGesture = 'left' | 'middle' | 'double'

export type ChordName = 'primary' | 'alternative'

/**
 * Which kind of link a click may reach.
 *
 * `detected` is what the link handlers and the `<uri|label>` scanner find in
 * plain output, `rules` is a run a text rule's pattern claimed — including an
 * integration's `detectPatterns`, which join the pool as synthetic rules — and
 * `osc8` is a link a program marked as one itself. Detection is unaffected: a
 * kind that is not clickable is still highlighted, hovered and previewed, and
 * the card's buttons are then how you act on it.
 */
export type ClickableKind = 'detected' | 'rules' | 'osc8'

export const CLICKABLE_KINDS: ClickableKind[] = ['detected', 'rules', 'osc8']

export interface ClickChord {
    modifier: ClickModifier
    gesture: ClickGesture
    /**
     * What the chord runs: a built-in id, the name of a rule's custom action,
     * or `none`. A rule may override it; `''` there means "inherit this".
     */
    action: string
}

/** The built-in action ids, which are the card's own buttons. */
export const BUILT_IN_ACTIONS = ['open', 'copyLink', 'copyPath', 'reveal'] as const

/** A chord that runs nothing. Distinct from `''`, which a rule uses to inherit. */
export const NO_ACTION = 'none'

/**
 * Out of the box: a plain click follows a link, and so does Ctrl+click — which
 * is what both this fork and Windows Terminal did before any of this was
 * configurable, and what a `clickableLinks.modifier` of null meant.
 */
export const DEFAULT_CHORDS: Record<ChordName, ClickChord> = {
    primary: { modifier: 'none', gesture: 'left', action: 'open' },
    alternative: { modifier: 'ctrl', gesture: 'left', action: 'open' },
}

interface ModifierKeys {
    ctrl: boolean
    alt: boolean
    shift: boolean
    meta: boolean
}

const MODIFIERS: Record<ClickModifier, ModifierKeys> = {
    none: { ctrl: false, alt: false, shift: false, meta: false },
    ctrl: { ctrl: true, alt: false, shift: false, meta: false },
    alt: { ctrl: false, alt: true, shift: false, meta: false },
    shift: { ctrl: false, alt: false, shift: true, meta: false },
    meta: { ctrl: false, alt: false, shift: false, meta: true },
    ctrlAlt: { ctrl: true, alt: true, shift: false, meta: false },
    ctrlShift: { ctrl: true, alt: false, shift: true, meta: false },
    altShift: { ctrl: false, alt: true, shift: true, meta: false },
    ctrlAltShift: { ctrl: true, alt: true, shift: true, meta: false },
}

export const CLICK_MODIFIERS = Object.keys(MODIFIERS) as ClickModifier[]

export const CLICK_GESTURES: ClickGesture[] = ['left', 'middle', 'double']

/**
 * Spellings that are not ours but mean one of ours: the Windows Terminal
 * fork's `win`, the platform names people reach for, and the four
 * `MouseEvent` property names that `clickableLinks.modifier` used.
 */
const MODIFIER_ALIASES: Record<string, ClickModifier | undefined> = {
    win: 'meta',
    cmd: 'meta',
    command: 'meta',
    'super': 'meta',
    ctrlkey: 'ctrl',
    altkey: 'alt',
    shiftkey: 'shift',
    metakey: 'meta',
}

export function normalizeModifier (value: unknown, fallback: ClickModifier = 'none'): ClickModifier {
    if (typeof value !== 'string') {
        return fallback
    }
    const key = value.trim()
    // `hasOwnProperty` on both, not a truthiness test: `MODIFIERS['constructor']`
    // is inherited from `Object.prototype` and is a function, and a config file
    // is hand-editable.
    if (Object.prototype.hasOwnProperty.call(MODIFIERS, key)) {
        return key as ClickModifier
    }
    const alias = key.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(MODIFIER_ALIASES, alias)) {
        return MODIFIER_ALIASES[alias] ?? fallback
    }
    return fallback
}

export function normalizeGesture (value: unknown, fallback: ClickGesture = 'left'): ClickGesture {
    return typeof value === 'string' && (CLICK_GESTURES as string[]).includes(value)
        ? value as ClickGesture
        : fallback
}

/**
 * The keys a modifier stands for, or nothing when it is a name we do not know —
 * which the type says cannot happen and a hand-edited `config.yaml` says can.
 */
function modifierKeys (modifier: ClickModifier): ModifierKeys | undefined {
    return Object.prototype.hasOwnProperty.call(MODIFIERS, modifier) ? MODIFIERS[modifier] : undefined
}

/**
 * Exact match: Ctrl and Ctrl+Shift are different chords, so holding an extra
 * modifier does not silently fall through to the plainer one. Without this a
 * Ctrl chord would fire in the middle of a Ctrl+Shift selection.
 */
export function modifierMatches (modifier: ClickModifier, keys: ModifierKeys): boolean {
    const wanted = modifierKeys(modifier)
    return !!wanted
        && wanted.ctrl === keys.ctrl
        && wanted.alt === keys.alt
        && wanted.shift === keys.shift
        && wanted.meta === keys.meta
}

/** The parts of a `MouseEvent` a chord is decided from. */
export interface PointerPress {
    /** 0 left, 1 middle, 2 right — `MouseEvent.button`. */
    button: number
    /** 1 for a single click, 2 for the second of a double — `MouseEvent.detail`. */
    clickCount: number
    ctrlKey: boolean
    altKey: boolean
    shiftKey: boolean
    metaKey: boolean
}

/**
 * `detail` is the browser's own click counter, so the second press *and* the
 * second release of a double click both report 2 — no timing of ours. It is 0
 * for an event that is not part of a click sequence at all.
 */
export function pressFromEvent (event: MouseEvent): PointerPress {
    return {
        button: event.button,
        clickCount: event.detail || 1,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
    }
}

export function gestureMatches (gesture: ClickGesture, press: PointerPress): boolean {
    switch (gesture) {
        case 'left':
            return press.button === 0
        case 'middle':
            return press.button === 1
        case 'double':
            return press.button === 0 && press.clickCount === 2
        default:
            return false
    }
}

/**
 * A double click is also a left click, so when both chords fit the same press
 * the more specific gesture has to win — otherwise an alternative bound to a
 * double click could never be reached past a plain-click primary.
 */
export function gestureRank (gesture: ClickGesture): number {
    return gesture === 'double' ? 2 : gesture === 'middle' ? 1 : 0
}

/**
 * Which chord a press matches, or null. A tie on gesture specificity goes to
 * the primary, which is the one the settings page lists first.
 *
 * Note that the chord's *action* is not consulted here: a rule may override it,
 * and `''` there means "inherit", so whether anything actually runs is decided
 * once the matched link's rule is known.
 */
export function matchChord (chords: Record<ChordName, ClickChord>, press: PointerPress): ChordName | null {
    const keys = {
        ctrl: press.ctrlKey,
        alt: press.altKey,
        shift: press.shiftKey,
        meta: press.metaKey,
    }
    const fits = (chord: ClickChord) =>
        modifierMatches(chord.modifier, keys) && gestureMatches(chord.gesture, press)

    const primary = fits(chords.primary)
    const alternative = fits(chords.alternative)
    if (primary && alternative) {
        return gestureRank(chords.alternative.gesture) > gestureRank(chords.primary.gesture)
            ? 'alternative'
            : 'primary'
    }
    if (primary) {
        return 'primary'
    }
    return alternative ? 'alternative' : null
}

const GESTURE_LABELS: Record<string, string | undefined> = {
    left: 'Click',
    middle: 'Middle-click',
    'double': 'Double-click',
}

/** "Ctrl+Click", "Middle-click", "⌘+Double-click" — for the card's hint line. */
export function describeChord (chord: ClickChord, macOS = false): string {
    const keys = modifierKeys(chord.modifier) ?? MODIFIERS.none
    const parts: string[] = []
    if (keys.ctrl) {
        parts.push('Ctrl')
    }
    if (keys.alt) {
        parts.push(macOS ? '⌥' : 'Alt')
    }
    if (keys.shift) {
        parts.push('Shift')
    }
    if (keys.meta) {
        parts.push(macOS ? '⌘' : 'Win')
    }
    parts.push(GESTURE_LABELS[normalizeGesture(chord.gesture)] ?? 'Click')
    return parts.join('+')
}

/** What the settings page writes when an existing `clickableLinks.modifier` is found. */
export interface LegacyChordMigration {
    primaryClickModifier: ClickModifier
    primaryClickGesture: ClickGesture
    primaryAction: string
    alternativeAction: string
}

/**
 * What an existing `clickableLinks.modifier` becomes, or null when there is
 * nothing to carry over.
 *
 * That setting is upstream's, it predates this, and it may well be in someone's
 * `config.yaml` — so unlike the Windows Terminal fork's `openLinksOnSingleClick`
 * it cannot simply be dropped. It said one thing: *only* a click holding this
 * key follows a link. So the modifier moves onto the primary chord, and the
 * alternative — which defaults to Ctrl+click — is silenced, because leaving it
 * would re-enable the very click the user turned off.
 */
export function migrateLegacyModifier (legacy: unknown): LegacyChordMigration | null {
    if (typeof legacy !== 'string' || !legacy.trim()) {
        return null
    }
    const modifier = normalizeModifier(legacy, 'none')
    if (modifier === 'none') {
        // Not a spelling we recognise, or explicitly "no modifier" — which is
        // what the default already is.
        return null
    }
    return {
        primaryClickModifier: modifier,
        primaryClickGesture: 'left',
        primaryAction: 'open',
        alternativeAction: NO_ACTION,
    }
}
