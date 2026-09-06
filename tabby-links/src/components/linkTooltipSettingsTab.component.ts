import { Component } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'

import { Integration, LinkTooltipAction, LinkTooltipRule, hydrateRule, newRule } from '../api'
import {
    CLICKABLE_KINDS,
    CLICK_GESTURES,
    CLICK_MODIFIERS,
    ChordName,
    ClickGesture,
    ClickModifier,
    ClickableKind,
} from '../clickChords'
import { FILE_TYPE_GROUP_LABELS } from '../fileTypes'
import { RulePreset, applyPreset, rulePresets } from '../presets'
import { checkPattern } from '../regexGuard'
import { IntegrationRegistryService } from '../services/integrationRegistry.service'
import { LinkClicksService } from '../services/linkClicks.service'

/** A comma-separated field, cleaned up. Empty entries are dropped, not stored. */
function splitList (value: string): string[] {
    return value.split(',').map(x => x.trim()).filter(x => x)
}

/**
 * A preset's pattern goes through the same guard as a typed one.
 *
 * It should never fail — `test/logic.test.js` measures every shipped preset
 * against `checkPattern` — but the pattern lands in the same box the user edits,
 * so the box's error line has to describe what is in it either way. A preset
 * that was quietly refused at compile time would otherwise look like a rule
 * that simply never fires.
 */
function checkPresetPattern (pattern: string): string {
    return pattern ? checkPattern(pattern).error : ''
}

const MODIFIER_LABELS: Record<ClickModifier, string> = {
    none: 'No modifier',
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    meta: 'Win / Cmd',
    ctrlAlt: 'Ctrl+Alt',
    ctrlShift: 'Ctrl+Shift',
    altShift: 'Alt+Shift',
    ctrlAltShift: 'Ctrl+Alt+Shift',
}

const GESTURE_LABELS: Record<ClickGesture, string> = {
    left: 'Left click',
    middle: 'Middle click',
    'double': 'Double click',
}

const KIND_LABELS: Record<ClickableKind, string> = {
    detected: 'Detected URLs and paths',
    rules: 'Text matched by a rule',
    osc8: 'Links a program marked itself',
}

@Component({
    selector: 'link-tooltip-settings-tab',
    templateUrl: './linkTooltipSettingsTab.component.pug',
    styleUrls: ['./linkTooltipSettingsTab.component.scss'],
})
export class LinkTooltipSettingsTabComponent {
    fileTypeGroups = FILE_TYPE_GROUP_LABELS
    currentRule: LinkTooltipRule | null = null
    patternError = ''
    integrations: Integration[] = []
    /**
     * A field, rebuilt when the integrations change, rather than a method the
     * template calls. `*ngFor` tracks by identity, so a method handing back a
     * fresh array on every change detection pass re-creates every menu item —
     * the shape that froze the whole window on the Integrations page.
     */
    presets: RulePreset[] = []

    /**
     * Fields, not methods: `*ngFor` tracks by identity, so a method handing back
     * a fresh array would re-create every `<option>` on every change-detection
     * pass. Same reason as `presets` above.
     */
    clickModifiers = CLICK_MODIFIERS.map(value => ({ value, label: MODIFIER_LABELS[value] }))
    clickGestures = CLICK_GESTURES.map(value => ({ value, label: GESTURE_LABELS[value] }))
    clickKinds = CLICKABLE_KINDS.map(value => ({ value, label: KIND_LABELS[value] }))

    constructor (
        public config: ConfigService,
        private platform: PlatformService,
        private clicks: LinkClicksService,
        registry: IntegrationRegistryService,
    ) {
        registry.integrations$.subscribe(list => {
            this.integrations = list
            // Presets take their patterns from the manifests, so the menu is
            // only correct once these have arrived.
            this.presets = rulePresets(list)
        })
    }

    get rules (): LinkTooltipRule[] {
        // Hydrated, because these come straight out of a file a person can
        // hand-edit and may be missing any key. Completed *in place* and the
        // stored array itself returned — `.map()` here would hand back a copy,
        // and adding, deleting or reordering a rule would then mutate a
        // throwaway and never reach the config.
        const stored = this.config.store.linkTooltip.rules as Partial<LinkTooltipRule>[]
        stored.forEach(hydrateRule)
        return stored as LinkTooltipRule[]
    }

    // ── clicking ─────────────────────────────────────────────────────────────

    /** "Ctrl+Click", as the chord currently reads. */
    chordDescription (name: ChordName): string {
        return this.clicks.describe(name)
    }

    hasKind (kind: ClickableKind): boolean {
        return this.clicks.kinds().includes(kind)
    }

    /**
     * Written back as a whole array rather than mutated in place: the stored
     * value may be the default array the config provider handed out, and
     * pushing into that would edit the default for everyone.
     */
    toggleKind (kind: ClickableKind): void {
        const kinds = this.clicks.kinds()
        this.config.store.linkTooltip.clickableKinds = this.hasKind(kind)
            ? kinds.filter(x => x !== kind)
            : [...kinds, kind]
        this.saveConfiguration()
    }

    get safeSchemes (): string {
        return (this.config.store.linkTooltip.safeSchemes ?? []).join(', ')
    }

    set safeSchemes (value: string) {
        this.config.store.linkTooltip.safeSchemes = splitList(value)
        this.saveConfiguration()
    }

    saveConfiguration (): void {
        this.config.save()
        this.platform.extraSafeSchemes = this.config.store.linkTooltip.safeSchemes ?? []
    }

    // ── the rule list ────────────────────────────────────────────────────────

    addRule (): void {
        const rule = newRule()
        this.rules.push(rule)
        this.currentRule = rule
        this.patternError = ''
        this.saveConfiguration()
    }

    /** Add a rule already filled in, and open it — a preset is a starting point. */
    addRuleFromPreset (preset: RulePreset): void {
        const rule = applyPreset(preset)
        this.rules.push(rule)
        this.currentRule = rule
        this.patternError = checkPresetPattern(rule.pattern)
        this.saveConfiguration()
    }

    /**
     * Overwrite the open rule with a preset.
     *
     * Only offered from inside the editor, where what is about to be replaced is
     * on screen — the alternative, a preset picker that silently rewrites a rule
     * from the list, would be a click with no visible subject.
     */
    applyPresetToCurrent (preset: RulePreset): void {
        if (!this.currentRule) {
            return
        }
        applyPreset(preset, this.currentRule)
        this.patternError = checkPresetPattern(this.currentRule.pattern)
        this.saveConfiguration()
    }

    trackPreset (index: number): number {
        return index
    }

    editRule (rule: LinkTooltipRule): void {
        this.currentRule = this.currentRule === rule ? null : rule
        this.patternError = ''
    }

    moveRule (rule: LinkTooltipRule, delta: number): void {
        const index = this.rules.indexOf(rule)
        const target = index + delta
        if (index === -1 || target < 0 || target >= this.rules.length) {
            return
        }
        this.rules.splice(index, 1)
        this.rules.splice(target, 0, rule)
        this.saveConfiguration()
    }

    deleteRule (rule: LinkTooltipRule): void {
        const index = this.rules.indexOf(rule)
        if (index === -1) {
            return
        }
        this.rules.splice(index, 1)
        if (this.currentRule === rule) {
            this.currentRule = null
        }
        this.saveConfiguration()
    }

    /** The one-line description under a rule's name in the list. */
    summary (rule: LinkTooltipRule): string {
        if (rule.match === 'text') {
            const target = rule.integration && rule.integration !== 'none'
                ? this.integrationName(rule.integration)
                : rule.integration === 'none' ? 'no preview' : 'any integration'
            return `text: ${rule.pattern || '(no pattern)'}  →  ${target}`
        }
        const parts: string[] = []
        if (rule.schemes.length) {
            parts.push(`scheme: ${rule.schemes.join(', ')}`)
        }
        if (rule.pattern) {
            parts.push(`pattern: ${rule.pattern}`)
        }
        if (rule.fileTypeGroup !== 'none' || rule.extensions.length) {
            parts.push('file type')
        }
        return parts.join(' · ')
    }

    integrationName (id: string): string {
        return this.integrations.find(x => x.id === id)?.name ?? id
    }

    // ── the rule editor ──────────────────────────────────────────────────────

    schemesOf (rule: LinkTooltipRule): string {
        return rule.schemes.join(', ')
    }

    setSchemes (rule: LinkTooltipRule, value: string): void {
        rule.schemes = splitList(value)
        this.saveConfiguration()
    }

    extensionsOf (rule: LinkTooltipRule): string {
        return rule.extensions.join(', ')
    }

    setExtensions (rule: LinkTooltipRule, value: string): void {
        rule.extensions = splitList(value)
        this.saveConfiguration()
    }

    /**
     * Patterns are checked before they are stored. A backtracking pattern here
     * runs synchronously against whatever a remote host printed, so catching it
     * at authoring time is far better than catching it as a frozen window.
     */
    setPattern (rule: LinkTooltipRule, value: string): void {
        rule.pattern = value
        this.patternError = value ? checkPattern(value).error : ''
        this.saveConfiguration()
    }

    hasOverride (rule: LinkTooltipRule, key: 'showDelay' | 'hideDelay' | 'maxWidth'): boolean {
        return rule[key] !== null
    }

    toggleOverride (rule: LinkTooltipRule, key: 'showDelay' | 'hideDelay' | 'maxWidth'): void {
        if (this.hasOverride(rule, key)) {
            rule[key] = null
        } else {
            rule[key] = this.config.store.linkTooltip[key]
        }
        this.saveConfiguration()
    }

    addAction (rule: LinkTooltipRule): void {
        rule.actions.push({ name: '', icon: '', type: 'openUrl', value: '' })
        this.saveConfiguration()
    }

    deleteAction (rule: LinkTooltipRule, action: LinkTooltipAction): void {
        const index = rule.actions.indexOf(action)
        if (index !== -1) {
            rule.actions.splice(index, 1)
            this.saveConfiguration()
        }
    }

    trackRule (index: number): number {
        return index
    }
}
