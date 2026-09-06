import { Injectable } from '@angular/core'
import { ConfigService, HostAppService, Platform } from 'tabby-core'

import {
    CLICKABLE_KINDS,
    ChordName,
    ClickChord,
    ClickableKind,
    DEFAULT_CHORDS,
    describeChord,
    matchChord,
    migrateLegacyModifier,
    normalizeGesture,
    normalizeModifier,
    pressFromEvent,
} from '../clickChords'

/**
 * The configured click chords, and whether a given press is one of them.
 *
 * Everything decided here is decided from the config alone — the link's own
 * action comes from `LinkRulesService.resolve`, because a rule may override it.
 */
@Injectable({ providedIn: 'root' })
export class LinkClicksService {
    constructor (
        private config: ConfigService,
        private hostApp: HostAppService,
    ) { }

    get clickable (): boolean {
        return this.config.store.linkTooltip?.clickable !== false
    }

    /** Which kinds a click may reach, in a stable order and with junk dropped. */
    kinds (): ClickableKind[] {
        const stored = this.config.store.linkTooltip?.clickableKinds
        if (!Array.isArray(stored)) {
            return [...CLICKABLE_KINDS]
        }
        return CLICKABLE_KINDS.filter(kind => stored.includes(kind))
    }

    reaches (kind: ClickableKind): boolean {
        return this.clickable && this.kinds().includes(kind)
    }

    chord (name: ChordName): ClickChord {
        const store = this.config.store.linkTooltip ?? {}
        const fallback = DEFAULT_CHORDS[name]
        const action = store[`${name}Action`]
        return {
            modifier: normalizeModifier(store[`${name}ClickModifier`], fallback.modifier),
            gesture: normalizeGesture(store[`${name}ClickGesture`], fallback.gesture),
            action: typeof action === 'string' ? action : fallback.action,
        }
    }

    /**
     * Which chord this press matches for a link of this kind, or null.
     *
     * The chord's action is deliberately not consulted: a rule can override it,
     * and an empty override inherits, so what actually runs is only knowable
     * once the matched rule is in hand.
     */
    match (event: MouseEvent, kind: ClickableKind): ChordName | null {
        if (!this.reaches(kind)) {
            return null
        }
        return matchChord(
            { primary: this.chord('primary'), alternative: this.chord('alternative') },
            pressFromEvent(event),
        )
    }

    /** "Ctrl+Click", "Middle-click" — how the chord reads to a person. */
    describe (name: ChordName): string {
        return describeChord(this.chord(name), this.hostApp.platform === Platform.macOS)
    }

    /**
     * Carry an existing `clickableLinks.modifier` onto the primary chord, once.
     *
     * That key is upstream's and predates the chords, so it may be in a real
     * `config.yaml` — the Windows Terminal fork could drop its equivalent
     * without a migration only because that one was in nobody's settings file.
     * It is cleared as it is read, which is what makes this idempotent without
     * a `config.version` bump: bumping the version here would make upstream's
     * own migrations skip these configs at the next sync.
     */
    migrateLegacyModifier (): boolean {
        const legacy = this.config.store.clickableLinks?.modifier
        const migrated = migrateLegacyModifier(legacy)
        if (!migrated) {
            return false
        }
        Object.assign(this.config.store.linkTooltip, migrated)
        this.config.store.clickableLinks.modifier = null
        this.config.save()
        console.info(
            `[tabby-links] clickableLinks.modifier "${legacy}" migrated to `
            + `linkTooltip.primaryClickModifier "${migrated.primaryClickModifier}"`,
        )
        return true
    }
}
