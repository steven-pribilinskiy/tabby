import { IntegrationManifest, IntegrationMatcher, LinkFileTypeGroup, LinkMatchKind, LinkTooltipRule, newRule } from './api'

/**
 * Ready-made rules, so adding one does not start with writing a regex.
 *
 * A preset is metadata plus a *criterion*, and the two come from different
 * places on purpose:
 *
 * - The **name, description and options** are written here. They are prose and
 *   presentation, and no manifest has anywhere to put them.
 * - The **pattern**, for anything an integration already knows how to match, is
 *   taken from that integration's manifest rather than copied. A second copy of
 *   the Jira key regex would be a second copy that can drift, and the manifests
 *   here are asserted byte-identical to the Windows Terminal fork's — so they
 *   move, and a hardcoded twin would quietly stop agreeing with the integration
 *   whose preview the rule exists to configure.
 *
 * The join is by **example**: a preset names a string its matcher must match,
 * and the matcher is selected by running the manifest's own patterns against
 * it. That survives reordering and rewording, needs nothing added to a manifest
 * (which would break the parity assertion), and fails *safe* — if no matcher
 * claims the example, or more than one does, the preset is simply not offered
 * rather than shipping a pattern nobody vouches for. The example doubles as
 * what the test matches each preset against.
 *
 * Only the three subjects no manifest covers — commit hashes, media files and
 * source files — carry a criterion written here.
 *
 * Every pattern below must pass `regexGuard.checkPattern`; a preset the guard
 * would then refuse is worse than no preset. `test/logic.test.js` measures them.
 */

export interface RulePreset {
    id: string
    /** Menu label. */
    name: string
    /** One line under it, and the item's tooltip. */
    description: string
    match: LinkMatchKind
    schemes: string[]
    pattern: string
    fileTypeGroup: LinkFileTypeGroup
    extensions: string[]
    integration: string
    preview: boolean
    /**
     * A string this preset claims to match: the URI or text for a pattern, a
     * file name for a file-type preset. It selects the manifest matcher, and it
     * is what the test holds the preset to.
     */
    example: string
}

/** A preset whose pattern lives in an integration manifest. */
interface ManifestPreset {
    id: string
    integration: string
    /** Used when the matcher has no `description` of its own. */
    label: string
    description: string
    match: LinkMatchKind
    example: string
    preview: boolean
}

/**
 * Note that none of these set `schemes`. The manifest patterns are anchored and
 * already name their scheme, so a `schemes` list beside one adds no criterion —
 * only a second thing to keep in step with a pattern this file does not own.
 */
const FROM_MANIFEST: ManifestPreset[] = [
    {
        id: 'jira-issue-keys',
        integration: 'jira',
        label: 'Issue keys in output',
        description: 'Turns a bare issue key printed by a build or a commit message into a hoverable link',
        match: 'text',
        example: 'CAB-8209',
        preview: true,
    },
    {
        id: 'jira-issue-links',
        integration: 'jira',
        label: 'Issue links',
        description: 'Jira issue URLs, the /browse/ form',
        match: 'link',
        example: 'https://example.atlassian.net/browse/CAB-8209',
        preview: true,
    },
    {
        id: 'github-pull-requests',
        integration: 'github',
        label: 'Pull request links',
        description: 'GitHub pull request URLs',
        match: 'link',
        example: 'https://github.com/Eugeny/tabby/pull/11383',
        preview: true,
    },
    {
        id: 'github-issues',
        integration: 'github',
        label: 'Issue links',
        description: 'GitHub issue URLs',
        match: 'link',
        example: 'https://github.com/Eugeny/tabby/issues/11511',
        preview: true,
    },
    {
        id: 'github-commits',
        integration: 'github',
        label: 'Commit links',
        description: 'GitHub commit URLs',
        match: 'link',
        example: 'https://github.com/Eugeny/tabby/commit/c79ccc1f0a7d4e2b1c3f5a6d8e9b0c1d2e3f4a5b',
        preview: true,
    },
    {
        id: 'slack-messages',
        integration: 'slack',
        label: 'Message links',
        description: 'Slack permalinks, including a link into a thread',
        match: 'link',
        example: 'https://myteam.slack.com/archives/C01234ABCD/p1712345678000100',
        preview: true,
    },
    {
        id: 'stith-session-uris',
        integration: 'stith',
        label: 'Session links',
        description: 'stith:// links to an agent session',
        match: 'link',
        example: 'stith://session/1a2b3c4d-5e6f',
        preview: true,
    },
    {
        id: 'stith-web-links',
        integration: 'stith',
        label: 'Web links',
        description: 'Links to a session on the stith web UI',
        match: 'link',
        example: 'https://stith.lvh.me/agent/1a2b3c4d-5e6f',
        preview: true,
    },
]

/**
 * The rest, which no integration describes.
 *
 * `git-commit-hashes` deliberately demands a letter somewhere in the run —
 * `(?=[0-9a-f]*[a-f])`. Without it every seven-digit number in the output is a
 * commit: PIDs, ports, byte counts and epoch seconds all light up, and a rule
 * that decorates everything is a rule people turn off. The cost is an all-digit
 * hash, which is a one-in-a-billion object at forty characters.
 */
const STANDALONE: RulePreset[] = [
    {
        id: 'git-commit-hashes',
        name: 'Git: Commit hashes in output',
        description: 'Abbreviated or full hashes printed by git — hoverable, and a place to hang a custom action',
        match: 'text',
        schemes: [],
        pattern: '\\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\\b',
        fileTypeGroup: 'none',
        extensions: [],
        integration: '',
        // Nothing looks a bare hash up, so asking would only ever spin.
        preview: false,
        example: 'c79ccc1f0a7d4e2b1c3f5a6d8e9b0c1d2e3f4a5b',
    },
    {
        id: 'media-files',
        name: 'Media: Images, audio and video',
        description: 'Links and paths that resolve to a media file',
        match: 'link',
        schemes: ['file', 'http', 'https'],
        pattern: '',
        fileTypeGroup: 'media',
        extensions: [],
        integration: '',
        preview: true,
        example: '/home/steve/captures/screenshot.png',
    },
    {
        id: 'source-code-files',
        name: 'Source code files',
        description: 'Local paths to a source file',
        match: 'link',
        schemes: ['file'],
        pattern: '',
        fileTypeGroup: 'sourceCode',
        extensions: [],
        integration: '',
        preview: true,
        example: '/home/steve/projects/tabby/tabby-links/src/presets.ts',
    },
]

/**
 * The one matcher of this kind that claims `example`, or null.
 *
 * Exactly one: two matchers claiming the same string means the manifest has
 * moved somewhere this file cannot follow, and picking either would be a guess.
 */
export function matcherForExample (
    matchers: IntegrationMatcher[],
    kind: LinkMatchKind,
    example: string,
): IntegrationMatcher | null {
    const claimed = matchers.filter(matcher => {
        if ((matcher.kind ?? 'link') !== kind || !matcher.pattern) {
            return false
        }
        try {
            return new RegExp(matcher.pattern).test(example)
        } catch {
            return false
        }
    })
    return claimed.length === 1 ? claimed[0] : null
}

/** What the integration presets need from an integration, and no more. */
export interface PresetIntegration {
    id: string
    name: string
    manifest: IntegrationManifest
}

/**
 * Every preset on offer, given the integrations that are installed.
 *
 * Built-in manifests are always present, so the manifest-backed presets are
 * always there in practice; a user manifest is never asked for one, because a
 * preset needs a name and a description this file has no way to invent.
 */
export function rulePresets (integrations: PresetIntegration[]): RulePreset[] {
    const out: RulePreset[] = []
    for (const entry of FROM_MANIFEST) {
        const integration = integrations.find(x => x.id === entry.integration)
        if (!integration) {
            continue
        }
        const matcher = matcherForExample(integration.manifest.matchers ?? [], entry.match, entry.example)
        if (!matcher) {
            continue
        }
        out.push({
            id: entry.id,
            // Falls back on an *empty* description as well as a missing one, so
            // not `??`. The matcher's own wording wins where it has one, which
            // is what makes a preset and the Integrations page's "Add as rule"
            // produce the same rule.
            name: `${integration.name}: ${matcher.description ? matcher.description : entry.label}`,
            description: entry.description,
            match: entry.match,
            schemes: [],
            pattern: matcher.pattern,
            fileTypeGroup: 'none',
            extensions: [],
            integration: integration.id,
            preview: entry.preview,
            example: entry.example,
        })
    }
    return [...out, ...STANDALONE]
}

/**
 * Write a preset over a rule — a fresh one by default.
 *
 * Everything the preset describes is replaced, and the overrides and button
 * suppression go back to "inherit", because a preset is an answer to *what to
 * match*, not to how long the card should wait. Custom actions are left alone:
 * they are the one thing on a rule that is unambiguously the user's own work,
 * and silently dropping them would make "apply preset" a destructive click.
 *
 * The arrays are copied. Two rules made from one preset must not share a
 * `schemes` array — editing one would edit the other, and the config file would
 * be written with a YAML anchor pointing at it.
 */
export function applyPreset (preset: RulePreset, rule: LinkTooltipRule = newRule()): LinkTooltipRule {
    rule.name = preset.name
    rule.enabled = true
    rule.match = preset.match
    rule.schemes = [...preset.schemes]
    rule.pattern = preset.pattern
    rule.fileTypeGroup = preset.fileTypeGroup
    rule.extensions = [...preset.extensions]
    rule.integration = preset.integration
    rule.preview = preset.preview
    rule.showDelay = null
    rule.hideDelay = null
    rule.maxWidth = null
    rule.suppressOpen = false
    rule.suppressCopyLink = false
    rule.suppressCopyPath = false
    rule.suppressReveal = false
    return rule
}
