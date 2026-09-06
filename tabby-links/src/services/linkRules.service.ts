import { Injectable } from '@angular/core'
import { ConfigService, NotificationsService } from 'tabby-core'

import { EffectiveTooltipSettings, LinkTooltipRule, LinkMatchKind, hydrateRule, newRule } from '../api'
import { DEFAULT_CHORDS } from '../clickChords'
import { matchesFileType } from '../fileTypes'
import { GuardedRegex, MAX_TEXT_INPUT } from '../regexGuard'
import { IntegrationRegistryService } from './integrationRegistry.service'

/** How many text patterns may be scanned at once, matching the other fork. */
export const MAX_TEXT_PATTERNS = 16

export interface CompiledRule {
    rule: LinkTooltipRule
    /** Unanchored, for the "does this link contain the pattern" test. */
    search: GuardedRegex | null
}

/**
 * A rule's notion of a scheme. A bare absolute POSIX path has none, but is a
 * file for every purpose a rule cares about — common from anything running
 * inside WSL — so it is reported as `file`, same as the other fork.
 */
export function schemeOf (text: string): string {
    if (text.startsWith('/')) {
        return 'file'
    }
    if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\')) {
        return 'file'
    }
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(text)
    return match ? match[1].toLowerCase() : ''
}

@Injectable({ providedIn: 'root' })
export class LinkRulesService {
    private compiled = new Map<string, GuardedRegex>()
    private cachedRules: LinkTooltipRule[] | null = null
    private cachedSource: unknown = null

    constructor (
        private config: ConfigService,
        private notifications: NotificationsService,
        private registry: IntegrationRegistryService,
    ) {
        // `config.store` is replaced wholesale on every reload — including a
        // reload triggered by another window — so nothing here may hold on to a
        // subtree reference. Dropping the caches is the whole handler.
        this.config.changed$.subscribe(() => {
            this.compiled.clear()
            this.cachedRules = null
            this.cachedSource = null
        })
    }

    get enabled (): boolean {
        return this.config.store.linkTooltip?.enabled ?? true
    }

    get detectLinks (): boolean {
        return this.config.store.linkTooltip?.detectLinks ?? true
    }

    /**
     * All rules, completed and as stored. Re-read on every call; only the
     * hydration is memoised, and only until the array is replaced.
     */
    rules (): LinkTooltipRule[] {
        const stored = this.config.store.linkTooltip?.rules
        if (stored !== this.cachedSource) {
            this.cachedSource = stored
            this.cachedRules = Array.isArray(stored) ? stored.map(hydrateRule) : []
        }
        return this.cachedRules ?? []
    }

    /** Enabled text rules with a usable pattern, capped. */
    textRules (): CompiledRule[] {
        const out: CompiledRule[] = []
        for (const rule of this.rules()) {
            if (!rule.enabled || rule.match !== 'text' || !rule.pattern) {
                continue
            }
            const search = this.regexFor(rule.pattern, 'g', rule)
            if (!search.usable) {
                continue
            }
            out.push({ rule, search })
            if (out.length >= MAX_TEXT_PATTERNS) {
                break
            }
        }

        // An integration's `detectPatterns` join the same pool, as synthetic
        // rules — which is what makes them obey the same 16-pattern cap, the
        // same ReDoS guard and the same first-match-wins resolution without any
        // of that being written twice. They come *after* the user's rules, so a
        // rule the user wrote about the same text still wins.
        for (const { integrationId, pattern } of this.registry.detectPatterns()) {
            if (out.length >= MAX_TEXT_PATTERNS) {
                break
            }
            const rule = newRule()
            rule.name = integrationId
            rule.match = 'text'
            rule.pattern = pattern
            rule.integration = integrationId
            const search = this.regexFor(pattern, 'g', rule)
            if (search.usable) {
                out.push({ rule, search })
            }
        }
        return out
    }

    /**
     * The tooltip behaviour for one hovered match: the first enabled rule whose
     * criteria all hold, or the global defaults when none does.
     *
     * Criteria are ANDed, and an unset criterion is skipped rather than treated
     * as false. Overrides are never merged across rules — the first match wins
     * outright, which is what makes the rule list readable top to bottom.
     */
    resolve (kind: LinkMatchKind, text: string, resolvedPath: string, matchedRule: LinkTooltipRule | null): EffectiveTooltipSettings {
        const store = this.config.store.linkTooltip
        const showButtons = store?.showButtons ?? true
        const settings: EffectiveTooltipSettings = {
            showDelay: store?.showDelay ?? 250,
            hideDelay: store?.hideDelay ?? 400,
            maxWidth: store?.maxWidth ?? 640,
            showOpen: showButtons,
            showCopyLink: showButtons,
            showCopyPath: showButtons,
            showReveal: showButtons,
            integration: '',
            showPreview: true,
            actions: [],
            primaryAction: typeof store?.primaryAction === 'string'
                ? store.primaryAction
                : DEFAULT_CHORDS.primary.action,
            alternativeAction: typeof store?.alternativeAction === 'string'
                ? store.alternativeAction
                : DEFAULT_CHORDS.alternative.action,
            rule: null,
        }

        const rule = matchedRule ?? this.firstMatchingRule(kind, text, resolvedPath)
        if (!rule) {
            return settings
        }

        settings.rule = rule
        if (rule.showDelay !== null) {
            settings.showDelay = rule.showDelay
        }
        if (rule.hideDelay !== null) {
            settings.hideDelay = rule.hideDelay
        }
        if (rule.maxWidth !== null) {
            settings.maxWidth = rule.maxWidth
        }
        // Suppression is absolute: it ANDs with the global toggle rather than
        // overriding it, so turning buttons off globally cannot be undone by a rule.
        settings.showOpen = settings.showOpen && !rule.suppressOpen
        settings.showCopyLink = settings.showCopyLink && !rule.suppressCopyLink
        settings.showCopyPath = settings.showCopyPath && !rule.suppressCopyPath
        settings.showReveal = settings.showReveal && !rule.suppressReveal
        settings.integration = rule.integration
        settings.showPreview = rule.preview
        settings.actions = showButtons ? rule.actions : []
        // An empty action id inherits the global chord action; `'none'` is a
        // deliberate "this rule has no such click" and is kept as-is, so the
        // dispatcher can tell it apart from inheriting. Unlike button
        // suppression this *replaces* rather than ANDing — a rule saying what a
        // click does has to be able to say "open" where the global says
        // "copyLink", not merely take things away.
        if (rule.primaryAction) {
            settings.primaryAction = rule.primaryAction
        }
        if (rule.alternativeAction) {
            settings.alternativeAction = rule.alternativeAction
        }
        return settings
    }

    private firstMatchingRule (kind: LinkMatchKind, text: string, resolvedPath: string): LinkTooltipRule | null {
        if (!text) {
            return null
        }
        for (const rule of this.rules()) {
            if (!rule.enabled || rule.match !== kind) {
                continue
            }
            if (kind === 'text') {
                // A text rule describes the pattern that found the run in the
                // first place, so the only criterion that means anything here is
                // that pattern, matched in full. An empty one can never match.
                if (!rule.pattern) {
                    continue
                }
                if (this.regexFor(rule.pattern, '', rule).fullMatch(text)) {
                    return rule
                }
                continue
            }
            if (!this.linkRuleMatches(rule, text, resolvedPath)) {
                continue
            }
            return rule
        }
        return null
    }

    private linkRuleMatches (rule: LinkTooltipRule, text: string, resolvedPath: string): boolean {
        const schemes = rule.schemes.map(x => x.trim().toLowerCase()).filter(x => x)
        if (schemes.length) {
            if (!schemes.includes(schemeOf(text))) {
                return false
            }
        }
        if (rule.pattern) {
            const regex = this.regexFor(rule.pattern, 'i', rule)
            if (!regex.usable || !regex.execAll(text, 1).length) {
                return false
            }
        }
        const group = rule.fileTypeGroup
        const extensions = rule.extensions
        if (group !== 'none' || extensions.length) {
            // Only meaningful for something that resolves to a file.
            if (!resolvedPath || !matchesFileType(resolvedPath, group, extensions)) {
                return false
            }
        }
        return true
    }

    private regexFor (source: string, flags: string, rule: LinkTooltipRule): GuardedRegex {
        const key = `${flags}|${source}`
        let regex = this.compiled.get(key)
        if (!regex) {
            regex = new GuardedRegex(source, flags, rule.name || source, {
                onDisabled: (label, elapsedMs) => {
                    this.notifications.error(
                        `Link rule "${label}" was turned off: its pattern took ${Math.round(elapsedMs)} ms to match. `
                        + 'Edit it on the Link Tooltip settings page.',
                    )
                },
            })
            this.compiled.set(key, regex)
        }
        return regex
    }
}

export { MAX_TEXT_INPUT }
