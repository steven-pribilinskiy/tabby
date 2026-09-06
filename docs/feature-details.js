// Long-form documentation, keyed by the ids in features.js.
//
// Kept separate from the catalogue on purpose: features.js is derived from git
// and stays machine-checkable, while everything here is written by hand and
// changes for editorial reasons rather than because a commit landed.
//
// Shape — every key optional except that a feature with no entry at all still
// renders, from features.js alone:
//   problem   why the feature exists — what goes wrong without it
//   how       what it actually does, in enough detail to be checkable
//   steps     a walkthrough someone can follow in their own build
//   settings  the config.yaml keys involved, with their real defaults
//   sample    { label, text } — literal recorded output, never a mock-up
//   notes     things worth knowing that are not caveats
//   caveats   what is NOT true, NOT proven, or borrowed from upstream.
//             These render in their own block. A catalogue that oversells is
//             worse than none, so anything CLAUDE.md hedges is hedged here.
//   upstream  what upstream Tabby does about it, where that is known
//
// Values here may contain inline HTML; they are inserted as written. `desc` in
// features.js may not — it is escaped everywhere it is rendered.
window.FEATURE_DETAILS = {

  // ---------------------------------------------------------------- links

  "link-tooltip": {
    problem:
      "A terminal prints links all day — URLs, file paths, issue keys, IP addresses — and a terminal's answer to all of them is the same: underline it, and open it if you Ctrl+click. You cannot tell where a link goes without following it, you cannot tell what a ticket key refers to without leaving the window, and Tabby could not make a file path or a bare IP clickable at all.",
    how:
      "Hovering a link opens a card that names the link, shows the path or URL it will really open, and offers Open, Copy and Show in folder. A <strong>Link Tooltip</strong> settings page holds rules — a pattern, and what the card should do for anything matching it. An <strong>Integrations</strong> page runs declarative <code>integration.json</code> manifests: a manifest says how to recognise a reference, how to fetch it, and which fields to show, so hovering a ticket key shows its title, status and assignee without a plugin being written for it. The manifest format is <code>tabby-links/INTEGRATIONS.md</code>, and the built-in manifests are kept interchangeable with the Windows Terminal fork this was ported from.",
    steps: [
      "Open Settings → <strong>Link Tooltip</strong> and leave <code>enabled</code> on.",
      "Print something with a link in it and hover it — a URL, or a path such as <code>./package.json</code>.",
      "Add a rule with the <strong>Add rule</strong> button to change the delay, the width, or which buttons that kind of link gets.",
      "Open Settings → <strong>Integrations</strong>, enable one, and fill in its credential. Hover a reference it claims.",
    ],
    settings: [
      { key: "linkTooltip.enabled", def: "true", note: "Master switch for the hover card. Detection stays on." },
      { key: "linkTooltip.detectLinks", def: "true", note: "Whether links are detected and made clickable at all." },
      { key: "linkTooltip.showDelay", def: "250", note: "Milliseconds of hover before the card appears." },
      { key: "linkTooltip.hideDelay", def: "400", note: "Milliseconds before it goes away." },
      { key: "linkTooltip.maxWidth", def: "640", note: "Upper bound on the card's width — further limited by the pane." },
      { key: "linkTooltip.showButtons", def: "true", note: "Show Open / Copy / Show in folder on the card." },
      { key: "linkTooltip.safeSchemes", def: "[]", note: "Extra URI schemes that open without a confirmation dialog." },
      { key: "linkTooltip.rules", def: "[]", note: "The rule list. Each rule is a pattern plus the overrides it applies." },
      { key: "linkTooltip.integrations", def: "{}", note: "Per-integration state, keyed by manifest id." },
    ],
    notes: [
      "<strong>Tabby's linkifier was broken for file paths and bare IPs.</strong> <code>@xterm/addon-web-links</code> filters every match through an internal <code>isUrl()</code> — <code>new URL(text)</code> must parse — so <code>UnixFileHandler</code>, <code>WindowsFileHandler</code> and <code>IPHandler</code> never produced a clickable link. Our provider vendors that addon's <code>LinkComputer</code> minus the filter, which fixes all three.",
      "<strong>A rule pattern is a remotely triggerable freeze.</strong> It runs synchronously on the mouse-move handler against text a remote host printed, and <code>(a+)+b</code> on thirty <code>a</code>s takes about twelve seconds. Patterns are probed at increasing input lengths and refused both on save and on compile, so a rule hand-written into <code>config.yaml</code> is covered too.",
      "Credentials live in <code>&lt;config dir&gt;/integration-credentials.json</code>, encrypted through the OS keystore — never in <code>config.yaml</code>, which Config Sync uploads verbatim.",
      "An unconfigured integration still gets Open and Copy link. Resolving a ticket key to a URL needs only the matcher; only <em>previewing</em> needs a credential.",
    ],
    caveats: [
      "The first version of the ReDoS probe used fixed 64-character inputs and took <strong>127 seconds</strong> on <code>(a+)+b</code> — it reproduced the freeze it was meant to prevent. The probe escalates input length now, which is also why Tabby's own default handler regexes survive: they contain nested quantifiers and are simply fast, so a static syntax check would have refused them.",
      "The punycode/IDN homograph annotation the reference fork has was silently dropped by this port and only added in a second pass. Several other keys degraded the same way — see <em>Field groups, tabs, actions and detected patterns</em>.",
    ],
    upstream:
      "Upstream ships <code>tabby-linkifier</code>, which detects links and opens them; it has no hover card, no rules and no integrations. Its Open and Show in folder use <code>openExternal('file://' + p)</code>, which yields <code>file://C:\\foo</code> on Windows — an existing upstream bug this fork sidesteps with <code>platform.openPath()</code> and <code>showItemInFolder()</code>.",
  },

  "rich-integrations": {
    problem:
      "The manifest format is shared with a Windows Terminal fork, and the whole point of that is that one manifest works in both. That fork grew five keys; a manifest using them <strong>degraded silently here</strong> — a field group rendered as nothing, an action was ignored, a comment tab vanished — which is a far worse failure than a manifest being rejected, and a far bigger threat to the format than any cosmetic divergence.",
    how:
      "<strong>fieldGroups</strong> gives named sets of display fields a heading on the card and a tri-state checkbox in settings; anything no group claims becomes an implicit unlabelled group shown first, so a manifest that groups only its secondary data still leads with its title. <strong>tabs</strong> carries a description body or a comment list behind a strip — Atlassian Document Format is flattened by walking the node tree, and markdown is parsed to data and never to HTML. <strong>actions</strong> is the only part of this subsystem that writes: a choice resolves its options from an earlier step, applies one, drops the cached preview and re-fetches so the badge updates in place. <strong>detectPatterns</strong> joins the scan pool as synthetic rules. Step <strong>optional</strong> records a failing step and steps over it.",
    settings: [
      { key: "linkTooltip.integrations.&lt;id&gt;.enabled", def: "false", note: "Whether this manifest is consulted at all." },
      { key: "linkTooltip.integrations.&lt;id&gt;.fields", def: "null", note: "Which display fields to show. <code>null</code> means the manifest's own list; <code>[]</code> means none." },
      { key: "linkTooltip.integrations.&lt;id&gt;.settings", def: "{}", note: "The manifest's own settings, seeded from each field's <code>default</code>." },
    ],
    notes: [
      "<strong>Undo is offered only when some other option leads back to where you were.</strong> Jira workflows are frequently one-directional, and the card says nothing rather than offering an undo that would fail.",
      "<strong>A failing optional step costs its section, not the card.</strong> Jira's Development panel and GitHub's richer endpoints are permission-dependent, and a 403 should not blank the preview.",
      "All four built-in manifests are held to the reference fork's copies <strong>key by key</strong>, at a pinned commit — so a key nobody thought to compare cannot drift. That checkout is somebody's live workspace whose HEAD moved four times during one session here; a test that reads its HEAD reports a different number every run, and parity stops being checkable.",
      "The divergences are a table in the test, and an entry is spent only when the key really differs — so one resolved upstream fails too, and asks for its entry back.",
    ],
    caveats: [
      "The parity assertion had in fact been <strong>red for some time</strong> — nine failures, drift on three of the four manifests — which is the same shape as the thing it exists to catch: a ported feature degrading quietly while the note above it says it is fine.",
      "<code>detectPatterns</code> is often belt and braces here. Tabby's own URI detector already claims anything with a <code>scheme://</code>, so <code>stith://…</code> in plain output was hoverable before this. Measured, not assumed — two providers claim it, both as a link. It earns its keep on patterns that are not URIs.",
      "<code>github.settings</code> and <code>github.matchers</code> are deliberately <em>not</em> adopted. The <code>repo#number</code> matcher needs owner resolution that no manifest key expresses, and adopting the JSON without it would produce a 404 offered as a suggested rule.",
    ],
  },

  "integration-html": {
    problem:
      "A field list is the right shape for a ticket and the wrong shape for anything that wants a layout of its own — a chart, a table, a run of coloured badges. The manifest format has an <code>html</code> key for exactly that, and both repositories documented it as \"reserved, not implemented in either fork\", which was wrong and cost a rediscovery.",
    how:
      "A manifest may carry a complete HTML document, rendered in place of the <code>fields</code> list and given <code>window.__data</code> — every fetch step's JSON, keyed by step id — and <code>window.__uri</code>. It talks back over <code>chrome.webview.postMessage</code> with <code>{height}</code> or <code>{open}</code>. <code>tabby-links/INTEGRATIONS.md</code> has the contract, <code>htmlHost.ts</code> builds the document, and <code>stith.json</code> is the worked example.",
    settings: [
      { key: "linkTooltip.allowHtml", def: "true", note: "Render a plugin's own HTML. Off falls back to the plain field list." },
    ],
    notes: [
      "<strong><code>sandbox=\"allow-scripts\"</code>, and nothing else, is the entire security story.</strong> Tabby's renderer is <code>nodeIntegration: true</code>, <code>contextIsolation: false</code> with no CSP anywhere in the app, so a plugin page that reached the parent realm would be <code>require('child_process')</code>, not XSS. Without <code>allow-same-origin</code> the frame is on an opaque origin and can do nothing but post a message. Verified live: <code>window.origin === 'null'</code>, no <code>require</code>, no <code>process</code>, and reading into the frame from the host throws <code>SecurityError</code>.",
      "<strong>A CSP is injected ahead of the document</strong> — <code>default-src 'none'</code>, <code>connect-src 'none'</code> — which the WebView2 host this was ported from does not do. The page renders data already fetched and cannot call home. <code>img-src https:</code> is the one exception, for parity with an icon on a fields card.",
      "<code>srcdoc</code> is written only when the card's key changes. Assigning it reloads the page and restarts its script, and the linkifier re-asks many times a second during output.",
      "<strong>The page could not be verified in the hidden dev build.</strong> Chromium throttles rendering for a cross-origin subframe that is never visible, so every measurement inside it reads 0 — a <code>height: 77px</code> div included. The test gives the page its own window, shown without focus and off-screen, purely so a compositor runs.",
    ],
    caveats: [
      "This is a port of a contract <strong>the originating fork cannot run</strong>: its WebView2 host is compiled behind a feature flag with no <code>WebView2Loader.dll</code> shipped, so <code>html</code> there always falls back to <code>fields</code>. This fork is the only place the key does anything.",
      "Measure <code>document.body.scrollHeight</code>, not <code>documentElement</code>'s — the latter is the frame's own viewport, so a page reporting it just asks to stay the size it already is. A silent no-op that looks exactly like a broken channel.",
    ],
  },

  "preview-pane": {
    problem:
      "A hover card is the right size for a status and a title and the wrong size for a description, a comment thread, or a page that wanted eight hundred pixels. It also disappears the moment you move the pointer, which is the wrong behaviour for anything you actually want to read.",
    how:
      "A button on the card opens the same preview in a real pane beside the terminal. <code>linkPreviewView.component</code> <em>is</em> the preview — groups, tab strip, markdown, comments, actions, the sandboxed frame — and the card and the pane each mount it. The only thing the pane passes that the card does not is room: a flag that swaps five CSS variables and a larger height cap for an <code>html</code> page, 4000px against the card's 320.",
    settings: [
      { key: "linkTooltip.hideTooltipsWithPane", def: "false", note: "Silence hover cards while a preview pane is open." },
    ],
    notes: [
      "<strong>This reverses a decision the fork had written down.</strong> <code>htmlHost.ts</code> used to say outright that \"a plugin asking for 1000px does not get the pane\", because there was no pane. Half of that still holds — the card is a hover affordance and stays clamped — and the comment now says which host each limit belongs to rather than stating a policy the code contradicts.",
      "<strong>A second copy of the markup is exactly how the pane would end up less sealed than the card</strong>, so the test asserts that no other template in the package contains an <code>iframe</code> at all.",
      "<strong>Suppression needs both halves</strong> — the setting and a pane actually open — which is what makes the switch safe to leave on: closing the last pane brings hover cards back without anyone having to remember.",
      "The pane takes the card's answers rather than resolving again. Asking a second time can get a different answer, because a text match has no link until an integration says so.",
      "Verified in a live window across 40 checks, including <strong>change-detection passes over an idle pane counted — measured 0 over 2.5s</strong>, because a runaway <code>*ngFor</code> does not fail a test, it hangs one.",
    ],
    caveats: [
      "<strong>A pane is not restored with the window.</strong> It has no recovery token, which is upstream's own path for a tab that cannot be recovered — and that path leaves the container's ratios one entry long, an upstream bug affecting any such tab. Deliberate: a preview pane re-running someone's ticket fetch at boot is not worth it.",
    ],
  },

  "click-chords": {
    problem:
      "Whether a link opens on a click, and what it opens with, was one boolean and one modifier. Alt+click and shift+click are selection gestures; middle click pastes; ctrl+left is a right click on Windows by default. All of those overlap with \"follow the link\", and one setting cannot express which one you meant.",
    how:
      "Two chords, <strong>primary</strong> and <strong>alternative</strong>, each a modifier × gesture × action — plus which kinds of link a click reaches at all (<code>detected</code>, <code>rules</code>, <code>osc8</code>) and a master switch. A rule may override either chord's action: <code>''</code> inherits, <code>'none'</code> suppresses. <code>clickChords.ts</code> is the whole decision, kept pure so the test can measure it rather than drive a window.",
    settings: [
      { key: "linkTooltip.clickable", def: "true", note: "Whether clicking a link activates it at all. Off, links are still detected, highlighted and previewed." },
      { key: "linkTooltip.clickableKinds", def: "['detected','rules','osc8']", note: "Which kinds of link a click reaches." },
      { key: "linkTooltip.primaryClickModifier", def: "'none'", note: "Matched exactly — Ctrl+Shift does not satisfy a plain-Ctrl chord." },
      { key: "linkTooltip.primaryClickGesture", def: "'left'", note: "left, middle or double." },
      { key: "linkTooltip.primaryAction", def: "'open'", note: "What the primary chord runs." },
      { key: "linkTooltip.alternativeClickModifier", def: "'ctrl'", note: "The second chord's modifier." },
      { key: "linkTooltip.alternativeClickGesture", def: "'left'", note: "The second chord's gesture." },
      { key: "linkTooltip.alternativeAction", def: "'open'", note: "What the alternative chord runs." },
    ],
    notes: [
      "<strong>Left resolves on release; middle and double resolve on the press.</strong> A press is also the start of a selection drag, so a left chord has to wait and then refuse if a selection was made. The other two have something to beat on the same event — the terminal pastes on a middle mousedown, and a double press selects a word — so they listen on <code>.xterm-screen</code> and stop propagation, but <strong>only once they know an action will actually run</strong>.",
      "<strong>xterm calls <code>activate</code> on any button's mouseup</strong>, with no button check, so a middle release would fire a second time after the press already did. <code>activate</code> therefore handles left gestures only.",
      "<strong>OSC 8 clicks are taken over, not forwarded.</strong> <code>tabby-linkifier</code>'s own handler decides for itself from the legacy modifier; leaving it in the wrapper would mean an OSC 8 link ignoring both the chords and the <code>osc8</code> filter, and opening twice whenever they agreed.",
    ],
    caveats: [
      "<strong>Alt+click and shift+click no longer follow a link.</strong> Modifiers match exactly, so a Ctrl chord does not fire mid-Ctrl+Shift-drag — and the price is that two gestures the old <code>!modifier</code> test allowed now do not. Both are selection gestures, and this is what Windows Terminal does.",
      "<code>terminal.rightClick: 'menu'</code> — the Windows default — already treats ctrl+left as a right click, so the default alternative chord pops a context menu <em>as well as</em> following the link. Unchanged from before, since the old <code>clickableLinks.modifier: null</code> had exactly the same overlap.",
    ],
    upstream:
      "<code>clickableLinks.modifier</code> is upstream's key and is <strong>migrated, not dropped</strong> — it may be sitting in a real <code>config.yaml</code>. The migration moves it onto the primary chord, silences the alternative (which defaults to Ctrl+click and would otherwise re-enable the very click the user turned off), and clears the key as it reads it, so it is idempotent without a <code>config.version</code> bump. A fork-owned bump would make upstream's own migrations skip these configs at the next sync.",
  },

  "rule-presets": {
    problem:
      "Adding a Link Tooltip rule started with an empty regex box. Almost every rule anyone actually wants — a ticket key, a commit hash, a pull request, a media file — is a pattern somebody has already written, and writing it again by hand is both work and a second copy that drifts.",
    how:
      "<strong>Add rule</strong> is a split button whose caret offers eleven ready-made rules, and an <strong>Apply preset</strong> dropdown inside the editor rewrites the rule you have open. <code>tabby-links/src/presets.ts</code> holds them. A preset does not own its pattern: anything an integration already matches takes the pattern <em>from that manifest</em>, selected by running the manifest's own matchers against a canonical example the preset names.",
    notes: [
      "<strong>The join fails safe.</strong> No matcher claims the example, or more than one does, and the preset is simply not offered — rather than falling back to a hardcoded twin that would drift.",
      "Presets are <strong>per matcher</strong>, not per subject, because that is how the manifests are written. Where the reference merges <code>pull|issues</code> into one preset, here they are separate.",
      "<code>\\b[0-9a-f]{7,40}\\b</code>, the reference's commit-hash pattern, is carried here as <code>\\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\\b</code>. Without the letter it demands, every seven-digit number in the output is a commit — PIDs, ports, epoch seconds — and a rule that decorates everything gets turned off.",
      "Applying a preset resets the delay and width overrides and the button suppression, but <strong>keeps custom actions</strong>: they are the one part of a rule that is unambiguously the user's own work.",
      "Every preset is timed through the ReDoS guard and against adversarial input at 512 and 4096 characters — measured worst 0.06 ms to check, 0.05 ms to match. A preset the guard would then refuse is a rule that silently never fires.",
    ],
  },

  "slack-links": {
    problem:
      "Slack and a good many CLIs emit <code>&lt;https://example.com|the label&gt;</code>. Tabby's URI handler stops at the pipe, so the URL half was clickable and the brackets and the label belonged to no link at all — measured before the fix, columns 0 and 33..43 of the construct resolved to <code>null</code>.",
    how:
      "The whole bracketed construct is one match, at a priority above every handler, in <code>delimitedLinks.ts</code>. It <em>encloses</em> the bare URI match and takes its cells, so hovering anywhere across the construct — bracket, URI, pipe or label — resolves to the same link.",
    steps: [
      "Print one: <code>printf '&lt;https://example.com|the label&gt;\\n'</code>.",
      "Hover the label. The card names the URL, not the label text.",
      "Hover the opening bracket. Same link — before this, nothing at all.",
    ],
    notes: [
      "<strong>The URI is still shown in full.</strong> Collapsing it to the label would mean the renderer showing text the buffer does not hold, which selection, copy, search and reflow all depend on.",
      "The delimited match ties with the text-rule tier deliberately, so a rule the user wrote for something inside the label still wins.",
    ],
    caveats: [
      "<strong>The bug the reference fork's commit describes does not exist here.</strong> There, <code>|</code> is inside the bare-URI character class, so the opener was handed <code>…/9962|repo#9962</code>. Tabby's <code>URLHandler</code> has no <code>|</code> in any of its classes and already stopped at the pipe. What was missing here was the other half — the brackets and label having no link — so the port is the same feature for a different reason.",
    ],
  },

  "wsl-links": {
    problem:
      "A path printed inside WSL means nothing to Windows, and the <code>\\\\wsl.localhost\\&lt;distro&gt;\\…</code> translation that fixes that was <strong>correct in isolation and never ran</strong>. So a path printed by anything inside WSL had no Copy path, no Show in folder, and a click that did nothing at all.",
    how:
      "The order was backwards: the whole thing was gated on the linkifier's <code>verify()</code>, which is <code>fs.access</code> on the string as written — for <code>/home/you/notes.md</code> that asks Windows about <code>C:\\home\\you\\notes.md</code>, which is false, so translation bailed before it could happen. Existence is now asked once, of the path that would actually be opened. What replaces <code>verify</code> as the \"is this a path\" test is <strong>rootedness</strong>, not existence.",
    steps: [
      "In a WSL tab, print an absolute path: <code>ls -d ~/Documents</code>.",
      "Hover it. The card shows the <code>\\\\wsl.localhost\\…</code> path it will really open.",
      "Click it, or use Show in folder. Explorer opens the real file inside the distro.",
    ],
    notes: [
      "<strong>Rootedness, not existence, is the right test.</strong> A text rule matches things like an issue key, and <code>fs.access('CAB-8209')</code> is answered against the app's own working directory, where it could plausibly exist. It also drops the <code>fs.access</code> that every hovered <code>http</code> URL used to cost.",
      "<strong><code>#L6-L7</code> is a fragment, not part of the name</strong> (RFC 3986 §3.5), and it was being carried into both the existence check and the shared path. It is stripped before percent-decoding, so a <code>#</code> genuinely in a filename — which has to arrive as <code>%23</code> — survives. Upstream has been asked for this since 2022 (GH#14116).",
      "<strong>An OSC 8 <code>file://</code> link arrives with no handler</strong>, so the <code>file://</code> branch of the resolver was dead code. That is the form Claude Code emits, and the one that carries a fragment.",
      "<code>file://&lt;authority&gt;/…</code> is a UNC path, which is how an editor writes a WSL link that already names its own distro. <code>/mnt/&lt;letter&gt;/</code> becomes the drive, since the share would answer for a file sitting on the local disk.",
      "<strong>Clicking takes the new route only when translation changed the path.</strong> A Windows path and an <code>http</code> link still go through the handler exactly as they did; asserted both ways.",
    ],
    caveats: [
      "<strong>Still wrong, and left alone:</strong> <code>~/notes</code> in a WSL tab is untildified to the <em>Windows</em> home by the upstream handler, so it resolves to the wrong file if that path happens to exist. Fixing it needs the distro's home, which costs a <code>wsl.exe</code> spawn on every hover.",
      "<code>verify()</code> is not consulted at all any more rather than being fixed. It is upstream code and every line changed there is rebase surface — and nothing is lost, since it <em>is</em> the existence check and it was being run on the wrong string.",
      "The reference fork's UTF-8 escape handling has no analogue here: its Windows API unescapes <code>%XX</code> a byte at a time, so <code>caf%C3%A9.md</code> arrives mojibaked, while <code>decodeURIComponent</code> is already correct.",
    ],
  },

  "card-clamp": {
    problem:
      "The hover card knew about the window and not about the pane it was floating over. In a narrow split it rendered past the pane's edge — worst exactly where you most need to read it.",
    how:
      "<code>position()</code> writes <code>--link-card-max-width</code>, the lesser of <code>linkTooltip.maxWidth</code> and the hovered <code>.xterm-screen</code>'s own width, <strong>before</strong> it reads the card's size. Clamping where an edge lands does nothing once the card is already wider than the pane. The setting is an upper bound, never the width.",
    notes: [
      "CSS applies <code>min-width</code> after <code>max-width</code>, so the cap has to be spelled into both — or the card's 220px minimum quietly wins back the overflow in a narrow split.",
      "The card is <code>position: fixed</code> but a DOM child of <code>.xterm-screen</code>: it has to be a descendant or xterm's hover guard never applies and <code>mouseleave</code> clears the link the instant the pointer reaches the card, and it has to be fixed or the pane's <code>overflow: hidden</code> clips it. The fixed containing block is not always the window, so it is placed by measuring its own origin at <code>translate(0,0)</code> and then translating.",
    ],
  },

  "url-punctuation": {
    problem:
      "Tabby's URL handler excluded <code>:</code>, <code>,</code> and <code>/</code> from the character classes it used for a URL's path and query, so a link stopped short of where it pointed — a line-number anchor, a list parameter, a nested path.",
    how: "Three characters, added to two character classes.",
    upstream:
      "Sent upstream as <a href=\"https://github.com/Eugeny/tabby/pull/11383\">Eugeny/tabby#11383</a> and <strong>not merged</strong>. It is carried here rather than waited for, which is what this fork is for.",
  },

  // --------------------------------------------------------------- claude

  "claude-panel": {
    problem:
      "Running several Claude Code sessions across several terminals means the interesting state — which one is waiting for you, which one is nearly out of context, what one of them last asked — lives in whichever tab you are not looking at.",
    how:
      "A panel docked to any edge of the window lists every session on the machine, and a tab's hover card says the same about the session running in <em>that</em> tab. It rests on two new generic extension points in <code>tabby-core</code>, both add-only files: <code>SidePanelProvider</code> contributes a panel to a dock host that owns the header, the edge picker and the resize handle, and <code>TabHoverProvider</code> contributes a rich hover card for a tab header, falling back to the plain title tooltip when no provider applies.",
    settings: [
      { key: "sidePanel.enabled", def: "false", note: "Show the docked panel." },
      { key: "sidePanel.side", def: "'right'", note: "left, right, top or bottom. Moving it never re-creates the component — it is a CSS grid area." },
      { key: "sidePanel.size", def: "320", note: "Width when docked left/right, height when top/bottom." },
      { key: "claude.stithURL", def: "'https://stith.lvh.me'", note: "The session registry the panel reads." },
      { key: "claude.pollIntervalMs", def: "2000", note: "How often the registry is asked." },
      { key: "claude.readTranscripts", def: "true", note: "Derive context-window usage from the transcript tail." },
      { key: "claude.hover.enabled", def: "true", note: "Show the tab hover card." },
      { key: "claude.clickAction", def: "'focus'", note: "What clicking a session in the panel does." },
    ],
    notes: [
      "<strong>Tabs are joined to sessions by directory, never by PID.</strong> A session inside WSL reports Linux PIDs that can never match Tabby's Windows conpty PIDs. Only an unambiguous 1:1 pairing is trusted — a card on the wrong tab is worse than no card.",
      "<strong>The join key is the <em>launch</em> directory, not <code>cwd</code>.</strong> A session's reported cwd follows every <code>cd</code> the agent makes; measured live, 2 of 13 sessions had already drifted. The launch directory is recoverable from the transcript's project folder name, whose encoding is lossy — so it is never decoded: the tab's directory is encoded the same way and the encoded forms compared, which is exact. Verified against the live registry: 11 of 13 reproduce, and the 2 that do not are exactly the drifted ones.",
      "<strong>The launch directory can be recovered</strong> by walking a drifted cwd's ancestors until one encodes to the project key. <code>claude --resume</code> only finds a session from its launch directory, so this is what makes Resume work at all.",
      "<strong>Data comes from the session registry, not from the hook spool.</strong> The spool is consume-and-delete, so a second reader would steal events from the plugin that owns audio and tab decoration. Reading the registry means zero conflict and no plugin changes.",
      "Transcripts reach <strong>160 MB</strong>, so one is never read whole — a 256 KB tail is enough, verified against every live session.",
    ],
    caveats: [
      "<code>getWorkingDirectory()</code> alone never matches Windows tabs: <code>tabby-local</code> deliberately returns null when the shell's live directory still equals the one it launched in — i.e. the common case of opening a terminal in a repo and running <code>claude</code>. The profile's cwd and the tab's initial cwd are used as fallbacks.",
      "The panel depends on a local session registry service being reachable. With nothing answering at <code>claude.stithURL</code> the panel is empty, which is the honest result rather than an error.",
    ],
  },

  // ------------------------------------------------------------- sessions

  "session-resume": {
    problem:
      "Upstream restores the furniture — the tabs, the splits, the profiles, and via the serialized scrollback a picture of what was on screen. Every pane still comes back as a fresh shell, so the agent you had a two-hour conversation with, the multiplexer holding six sessions and the dev server are all simply not running any more. Restoring the furniture is not restoring the work.",
    how:
      "Each pane is asked what it is running, the answer is persisted alongside the layout, and on the next start it is typed back into the restored pane. A native pane is read from the process tree — the <em>shallowest</em> non-shell descendant of the pane's own shell, not the deepest, because an agent spawns a child per MCP server. A WSL pane cannot be read that way at all, so <code>tabby-local</code> now mints a <code>TABBY_SESSION</code> per pane and appends it to <code>WSLENV</code>, and one probe per distro greps every <code>/proc/*/environ</code> at once.",
    steps: [
      "Turn on <strong>Restore tabs</strong> under Settings → Startup — resume rides on the persisted layout.",
      "Leave <code>resume.agents</code> and <code>resume.multiplexers</code> on. Anything else goes in <code>resume.extraPrograms</code> by name.",
      "Open a pane and start something: an agent, or <code>tmux new-session -s demo</code>.",
      "Close the window, or kill it outright.",
      "Reopen. The pane comes back on its own profile, in its own directory, running what it was running.",
    ],
    settings: [
      { key: "resume.agents", def: "true", note: "Reopen a known agent's conversation, keeping the options it was launched with." },
      { key: "resume.multiplexers", def: "true", note: "Reattach to shefrd, herdr, tmux, screen or zellij." },
      { key: "resume.extraPrograms", def: "[]", note: "Extra program names, re-run exactly as they were found." },
      { key: "resume.excludedPrograms", def: "[]", note: "Never resume these. Beats every setting above." },
      { key: "resume.notification", def: "'toast'", note: "silent, toast, or confirm — which lists what it would do and waits." },
      { key: "resume.inputDelayMs", def: "1200", note: "How long a restored pane's shell gets to draw a prompt before the command is typed." },
      { key: "resume.refreshIntervalSec", def: "30", note: "How often each pane is asked what it is running — i.e. how stale a recorded command can be." },
      { key: "resume.wslProbeTimeoutMs", def: "5000", note: "How long a distro gets to answer before its panes go unmeasured." },
    ],
    notes: [
      "<strong>Typed into the pane, never launched as it.</strong> Putting the command in the profile's command line would make it the pane's root process, so the pane would close the moment the program exited. The Enter goes as its own write — many TUIs read one write containing text and newline as a bulk paste and never submit it.",
      "<strong><code>tpgid</code> describes the terminal, not the process.</strong> Every process sharing a controlling terminal reports the same value, so \"the topmost process's tpgid\" is not that process's opinion about its children. The port read it the first way and reported nothing at all for a pane with anything between it and its shell. The rule is now <code>pid === pgrp === tpgid</code>, with a parent inside the pane.",
      "<strong>One <code>wsl.exe</code> probe per distro, never per pane.</strong> The obvious loop reads each <code>/proc/*/environ</code> and forks four helpers per process, which on this machine's 1531-process distro measured 3.5s against about 250ms for a single grep.",
      "<strong>A restored pane does not start its shell until it is first rendered</strong>, and only the tab that ends up selected is rendered at startup. The first version gave up after ten seconds and every restored pane but the active one silently lost its resume — measured, two panes, hours later. The wait now has no deadline and ends when the tab does.",
      "<strong>\"Open in new window\" is excluded by identity, not by heuristic.</strong> That flow reuses the running PTY, so the pane's agent never stopped.",
      "It rests on one new generic extension point in <code>tabby-core</code>, an add-only file: <code>TabRecoveryAugmentor</code> runs for every recovery token whatever its type, so a plugin can persist something about a tab without owning that tab or editing the provider that does.",
      "<strong>Nothing on the save path.</strong> Measured live: <code>augment</code> 0.002–0.010 ms per tab, <code>saveTabs</code> under 0.01 ms, worst event-loop gap during a full capture 11 ms — against the 250 ms the diagnostics call a stall.",
    ],
    caveats: [
      "<strong>A recorded command is up to one <code>refreshIntervalSec</code> stale.</strong> There is no flush-before-quit seam to hang a probe on: upstream's own <code>closeWindow</code> disables tab recovery <em>before</em> its final save, so that save does nothing. Same guarantee Tabby already gives the scrollback saved beside it.",
      "<strong>Only agents whose resume syntax is actually known are in the table.</strong> Guessing a flag produces a command that fails at restore, which is worse than getting a shell — anything unlisted can still be named in <code>resume.extraPrograms</code>.",
      "<strong>A pane that reopens an agent conversation does not repaint its scrollback.</strong> The agent redraws its own history and both would show the same transcript twice.",
      "Multiplexer-owned processes are skipped on purpose: they belong to the daemon, which restores them itself.",
    ],
    upstream:
      "Restoring the layout and the buffer contents is upstream's. Restoring the running process is not, in Tabby or in Windows Terminal — Microsoft closed the equivalent thread with \"restoring the actual state of the running executable might be impossible\" and stopped at the text.",
  },

  "window-geometry": {
    problem:
      "Upstream keeps one <code>windowBoundaries</code> key that every window reads and writes. With one window that is invisible; with two it is wrong immediately — the second opens exactly on top of the first, and whichever closes last overwrites the other. Multi-window is fork-added here; the persistence is upstream's and was never scoped to it.",
    how:
      "Position and size are remembered per window, in <code>&lt;config dir&gt;/window.json</code> under <code>windowGeometries</code>. The identity is the window ordinal, because it is the only one Tabby already has — slots are claimed lowest-free and released on close, so open order decides them and close order cannot disturb them.",
    notes: [
      "<strong>\"On screen\" is decided by the title bar, not by area.</strong> The old check only fired when the saved rectangle missed the nearest display entirely, so a window whose title bar was above the top of the screen was restored exactly there and could not be dragged back. A rectangle now needs 120px of width and a 32px strip of its top edge inside some work area.",
      "<strong>A frameless window reports back 2px taller than the size its constructor was given.</strong> Measured, consistently — so a window only ever opened and closed grew 2px and crept down the screen every launch. Upstream has this too. <code>setBounds</code> is exact, so the restored rectangle is applied once more after construction.",
      "<strong>No DPI is stored.</strong> Windows Terminal's version of this keeps physical pixels and rescales them; Electron's screen coordinates are already per-display DIPs, so rescaling would introduce exactly the drift it exists to prevent.",
      "A slot with nothing saved cascades 28px off the newest live window, wrapping at the work area edge, rather than opening on top of it.",
      "Slot 1 is mirrored back to <code>windowBoundaries</code>, so a build without slots — upstream, or an older one of ours — still finds the main window's place.",
      "Every placement writes a record to <code>diagnostics.log</code>, and an adjusted one says what was wrong. \"Why did my window open there\" is otherwise unanswerable from outside the process.",
    ],
    caveats: [
      "<strong>Closing window 1 and opening another mid-session hands the new one slot 1</strong>, so it lands where window 1 was. Open order at launch is not a guess — <code>app.on('ready')</code> creates exactly one window — but nothing else about a window survives a restart to key off.",
      "<strong>No setting.</strong> The reference fork gates its equivalent behind <code>rememberWindowGeometry</code> because there it is new behaviour; here geometry has always been remembered and this only fixes who it belongs to, so a toggle would be a way to ask for the bug back.",
      "Geometry is written on close and 2s after the last move or resize — so a crash, a session ending, and the watchdog's own <code>app.exit()</code> all skip the close write.",
    ],
  },

  // ------------------------------------------------------------- terminal

  "xterm6": {
    problem:
      "Tabby's <code>terminal.frontend: xterm</code> meant <code>@xterm/addon-canvas</code>, last released in April 2024 against <code>@xterm/xterm ^5.0.0</code> and deleted outright by xterm 6. It is also the renderer behind every stale-glyph report upstream has open: it repaints only the rows it believes are dirty, so anything it draws and then loses track of stays on screen until something forces a full repaint.",
    how:
      "WebGL is what draws a pane. <code>XTermFrontend</code> now means xterm's own DOM renderer — slow but always correct — and is the fallback for the SwiftShader workaround and for a pane whose WebGL context could not be recovered. A saved <code>frontend: xterm</code> is <em>aliased</em> to WebGL rather than migrated: a fork-owned bump of <code>config.version</code> would make upstream's own migrations skip these configs at the next sync.",
    notes: [
      "Four things break against 6.0, each checked against the shipped sources rather than the changelog: <code>overviewRulerWidth</code> became an object; <code>_core.viewport._refresh()</code> is gone and <code>queueSync()</code> replaces it; <code>_core.browser</code> is a module namespace whose properties are read-only getters, so it must be spread rather than assigned into; and <code>scrollToBottom()</code> gained <code>disableSmoothScroll</code>, without which every pinned write starts a scroll animation.",
      "xterm 6 paints <code>.xterm-viewport</code> black and <code>.xterm-scrollable-element</code> white, both on top of Tabby's background — measured, not theorised. Both are overridden. The scrollbar slider needs nothing: xterm derives it from the theme's foreground at 20/40/50% opacity, which already follows a light or dark scheme.",
      "The synchronous row render after a fit stays. It is what closes the blank frame during a window drag, and <code>xterm.refresh()</code> cannot replace it — that goes through the render debouncer and lands a frame later.",
    ],
    caveats: [
      "<strong>The stale-glyph artifacts that prompted this work are not reproduced by the test written to measure them.</strong> <code>tabby-terminal/test/glyphs.cdp.js</code> fills the scrollback past capacity, scrolls with real wheel events while output arrives, resizes mid-flow and diffs the renderer's own canvases against a forced full repaint — and reports <strong>0 dirty cells on canvas, on WebGL and on xterm 6</strong>. Its instrumented repaint counter says why: under that generator a full-viewport repaint follows nearly every buffer scroll, so nothing can go stale. Retiring the canvas renderer is well-founded on its own; it is <em>not</em> measured to be the fix.",
      "<strong><code>@xterm/addon-unicode-graphemes@0.4.0</code> cannot be put in this bundle at all</strong>, and that is still unexplained. Importing it into <code>tabby-terminal</code> — importing, not using — spins the renderer at 100% CPU during module evaluation, measured at 270s and climbing, and V8's inspector cannot interrupt it. Not the ESM entry, not babel, and not the addon itself, which loads standalone in 11–15 ms. This forced an earlier attempt at the xterm 6 upgrade to be reverted, and it is why emoji width is still broken here.",
    ],
  },

  "contrast-default": {
    problem:
      "<code>terminal.minimumContrastRatio</code> defaulted to 4, and the value goes straight into xterm.js, which rewrites <strong>every</strong> foreground that misses the ratio — 24-bit colours included, since its minimum-contrast path has no exemption for them. At 4, Solarized Light on a light background sits at 3–5:1, so all thirteen of its colours get pushed toward mud and near-neighbours collapse onto each other.",
    how:
      "The default is now 1 — xterm.js's own \"off\" value, and its own default. The same key also drove the app chrome's contrast floor, so the chrome now floors at its own <code>UI_MINIMUM_CONTRAST_RATIO = 4</code> via <code>max(4, terminal.minimumContrastRatio)</code>: measured identical output at 1 and at 4, while 6 still escalates it, so raising the setting for accessibility keeps working.",
    settings: [
      { key: "terminal.minimumContrastRatio", def: "1", note: "Was 4. 1 is off — draw what the application asked for." },
    ],
    upstream:
      "Windows Terminal's equivalent, <code>adjustIndistinguishableColors</code>, resolves <code>Automatic</code> → <code>Never</code> unless Windows high-contrast is on. So this is now \"draw what the app asked for\", the same as Windows Terminal and iTerm2.",
  },

  "web-search": {
    problem:
      "Looking up something on screen meant selecting it, copying it, finding a browser and pasting it. Upstream Tabby has no web-search action anywhere.",
    how:
      "Right-clicking a selection offers <strong>Search the web for \"…\"</strong>, which opens <code>terminal.webSearchQueryURL</code> through the platform's external-open. Windows Terminal's <code>searchWeb</code> is the model — but its Bing default wraps the selection in <code>%22…%22</code>, which this deliberately does not: the selection searches as ordinary terms.",
    settings: [
      { key: "terminal.webSearchQueryURL", def: "'https://www.google.com/search?q={{query}}'", note: "Must be http(s) and contain {{query}}." },
    ],
    notes: [
      "<strong>The template is parsed twice and the origins compared.</strong> The selection is text a remote host printed. <code>encodeURIComponent</code> alone already stops it becoming a second parameter or a fragment, but the template is also probed with an inert stand-in and the result refused unless the scheme is http(s) and the final URL's origin is identical to the probe's — so it can never be turned into a request to a different host by what was selected.",
      "<code>{{query}}</code>, not Windows Terminal's <code>%s</code>: <code>{{name}}</code> is already how every URL built from matched text is written here, so there is one templating convention in the repo rather than two.",
      "<strong><code>&amp;</code> in a menu label is a mnemonic on Windows and Linux</strong>, so a selection of <code>foo &amp; bar</code> would show as <code>foo _bar</code>. It is doubled for those platforms and left alone on macOS. Truncation happens before the doubling, or a cut could split a <code>&amp;&amp;</code>.",
      "Selections are capped at 512 characters and whitespace runs collapse to single spaces — a terminal selection can be megabytes, and a multi-line one has to search, and label, as one line.",
    ],
  },

  "wsl-cwd": {
    problem:
      "A WSL tab reported no working directory at all, which means no directory in the tab title, nothing for a new tab to inherit, and nothing for anything else to join a tab to. Tabby's <code>OSCProcessor</code> understood iTerm's OSC 1337 and not OSC 7 — and OSC 7 is what default bash and zsh, WSL's included, actually emit.",
    how:
      "<code>OSCProcessor</code> parses OSC 7's <code>file://host/path</code> form as well as OSC 1337. Separately, a WSL profile's working directory can be picked from a browser that runs inside the distro, so it is chosen from what is really there rather than typed as a guess.",
  },

  // ------------------------------------------------------------------- ui

  "vertical-tabs": {
    problem:
      "Tab titles in this fork are working directories and session names. A horizontal strip truncates them well before the useful part, and Tabby's side tab bar was a fixed width with a single column.",
    how:
      "The side bar can be dragged to a width that is persisted, and flows into multiple columns as it gets wider — a column narrower than the minimum is not created, so columns appear only once there is room for a whole one. Vertical is the default here.",
    settings: [
      { key: "appearance.tabsLocation", def: "'left'", note: "Was <code>top</code>. Only affects profiles with no value saved." },
      { key: "appearance.sideTabBarWidth", def: "200", note: "Persisted when the splitter is dragged." },
      { key: "appearance.sideTabBarMultiColumn", def: "false", note: "Let the bar flow into multiple columns." },
      { key: "appearance.sideTabBarMinColumnWidth", def: "200", note: "A column narrower than this is not created." },
      { key: "appearance.colorSchemeMode", def: "'auto'", note: "Was <code>dark</code>, which ignored the OS setting on a fresh profile." },
    ],
    caveats: [
      "<strong>Every changed default is a line that conflicts on rebase</strong>, so they are kept to a minimum and listed in CLAUDE.md. <code>colorSchemeMode: auto</code> is a changed <em>default</em> — following the OS scheme is upstream Tabby's own mechanism, and <code>auto</code> was already a supported value.",
      "Separate light and dark colour schemes are <strong>stock upstream Tabby</strong>. Nothing here added that.",
    ],
  },

  "theme-repairs": {
    problem:
      "Tabby's light schemes lost control borders and surface separation, hover states went illegible, colour swatches had no labels, and on Windows the window had no opaque backing surface — so a transparent frame showed the desktop through the chrome.",
    how:
      "Borders and separation restored on light schemes, hover contrast fixed, swatches labelled, tooltips added where a control said nothing, an opaque backing colour applied on Windows, and the dark-mode active tab given real contrast — with the active-tab bar dropped in vertical bars, where it duplicates the selection it sits inside.",
    caveats: [
      "<code>setDarkMode</code> had to be guarded against an unset vibrancy state, which threw during window construction — a fix for the fix.",
    ],
  },

  "accent-colour": {
    problem:
      "Every <code>&lt;code&gt;</code> in the app — paths, commits, identifiers, the build tooltip — was Bootstrap's <code>#d63384</code>, a pink belonging to no colour scheme here. <code>theme.vars.scss</code> overrode it to orange, but nothing imports that file any more, so the pink was live and was the last hardcoded accent left in the UI.",
    how:
      "<code>appearance.accentColor</code> (Settings → Window) replaces it. Null follows the colour scheme.",
    settings: [
      { key: "appearance.accentColor", def: "null", note: "Colour for code, paths and identifiers in the UI. Null follows the colour scheme." },
    ],
    notes: [
      "<strong>The configured value is parsed before it is used.</strong> The theme variables are recomputed on every keystroke in the settings box, and a half-typed <code>#ab</code> thrown out of the colour parser would take every other variable in that pass with it.",
      "It goes through the same contrast floor as the rest of the chrome, so a pale pick is darkened against the window background rather than left illegible.",
      "The build tooltip now follows the theme instead of being Bootstrap's near-black — which is what keeps the accent inside it legible, since it is contrasted against the window and not against black.",
    ],
  },

  "splash-scheme": {
    problem:
      "The window's backing colour already followed the OS scheme; only the splash CSS was hardcoded dark, so a light desktop got a black flash before the window drew.",
    how:
      "<code>app/src/preload.scss</code> keeps its dark values exactly as they were and appends a <code>@media (prefers-color-scheme: light)</code> block overriding four of them — an override rather than a pair of themes, so the dark path's diff is nil and the rebase surface on an upstream file stays one appended block.",
    notes: [
      "<strong><code>prefers-color-scheme</code> is already correct when the splash paints.</strong> <code>setDarkMode()</code> runs during window construction, before the page is shown, so the media query reflects the user's <code>colorSchemeMode</code> choice rather than merely the OS default.",
      "The light background is <code>#f5f7f9</code>, deliberately not white: the logo's palest gradient stops all but vanish against pure white.",
      "Verified by extracting the compiled stylesheet out of the built preload bundle and rendering the real splash markup under both theme sources in an off-screen window — dark stays exactly <code>#1d272d</code>/<code>#a1c5e4</code>, light comes back <code>#f5f7f9</code>/<code>#2f5d80</code>.",
    ],
  },

  "tab-actions": {
    problem:
      "Split and Open in new window were offered for terminal tabs and not for anything else, and moving a tab out started a fresh session rather than carrying the running one.",
    how:
      "The tab context menu offers both for every tab, and the new window adopts the running session.",
  },

  "build-hint": {
    problem:
      "Running a source build, a slot and the installed app side by side means constantly answering \"which one is this?\" — and getting it wrong means testing in the window holding your real work.",
    how:
      "A hint in the tab bar names the build. Its tooltip carries the commit, the branch, how old the build is in relative terms, and the paths the instance is actually running from — which is the question the version number cannot answer.",
    notes: [
      "The tooltip is kept inside the window rather than opening off the edge of the screen.",
      "The build constants can only be read from <em>inside</em> a running instance, which is exactly why the Builds page — which describes builds sitting on disk — reads a sidecar file instead.",
    ],
  },

  "jump-list": {
    problem:
      "Right-clicking Tabby in the taskbar or the Start menu offers your profiles, and every entry carried the app's own icon — a column of identical Tabby logos that told you nothing about what you were about to open.",
    how:
      "A profile icon is a Font Awesome class or an inline SVG document, and Windows' <code>iconPath</code> takes neither — it wants a file plus an index. So they are rasterised: the same conclusion the Windows Terminal maintainers reached, except that here <strong>the renderer already is a text-and-SVG rasterizer</strong>, so a canvas does it with no native code and no new dependency. <code>.ico</code> is written by hand, as a directory plus one PNG per size (16/24/32/48), which has been legal since Vista.",
    notes: [
      "<strong>The glyph comes out of the stylesheet, not a table of codepoints.</strong> A probe element gets the class and <code>getComputedStyle(el, '::before').content</code> answers with the character. That covers solid, regular and brands at once, survives a Font Awesome bump, and a class that resolves to no icon font is how an unknown one is detected.",
      "<strong>The blank check is the only honest test.</strong> A font that had not loaded, an SVG whose paths fall outside its viewBox and a mistyped class all produce a perfectly well-formed file full of nothing. The canvas is scanned for a non-transparent pixel before anything is written. <strong>An entry is never dropped and never blank.</strong>",
      "<strong>The webfont has to be waited for.</strong> <code>font-display: block</code> means the CSS knows the family long before the file arrives, and a canvas silently substitutes rather than waiting — so the first rebuild after a cold start drew tofu.",
      "<strong>An empty custom category makes the shell reject the whole call</strong>, not just that category — so on a profile where nothing had been opened yet, upstream's list was refused entire and no profiles appeared at all.",
      "<strong><code>profile \"&lt;name&gt;\"</code> was interpolated, not quoted.</strong> Profile names are free text; one containing a quote produced an entry that opened the wrong profile or none.",
      "The colour is Windows' <code>SystemUsesLightTheme</code>, not <code>AppsUseLightTheme</code> and not Tabby's own scheme — the jump list is taskbar chrome, and a monochrome glyph baked in the wrong colour is invisible against the flyout, which looks exactly like the blank tile this set out to fix.",
      "Measured on the renderer thread, 28 profiles: a cold pass draws 15 distinct icons in about 1.1s (0.3s once the webfonts are warm), a warm pass draws none and costs nothing. The loop awaits I/O between icons, so that is not 1.1s of blocked event loop.",
    ],
    caveats: [
      "<strong>The jump list itself is upstream's.</strong> <code>dockMenu.service.ts</code> already built it and already called <code>setJumpList</code>; what every entry got was <code>iconPath: process.execPath</code>. This is a fix to that call plus two add-only services, not a new feature.",
      "<strong>Only one packaged Tabby has a jump list file on this machine</strong>, and its entries point at the fork's own slot rather than the installed app. Either the two share an app identity and the slot wrote last, or the installed app's write never landed. Not resolved — worth knowing before trusting a jump list to belong to the build you think it does.",
      "Dev-build entries are dead either way: <code>electron.exe profile \"X\"</code> has no app path, so it starts nothing. Left alone, since it is upstream's shape and it now lands on an identity nothing else uses.",
      "The reference fork's profile-icon caching does <strong>not</strong> apply here and was skipped deliberately: Tabby has no URL profile icons to cache.",
    ],
  },

  "settings-polish": {
    problem:
      "A setting you had changed gave no hint what it used to be, and a range slider committed its value on mouseup — so dragging one previewed nothing at all until you let go, which is exactly backwards for every setting a slider is used for.",
    how:
      "A control that is off its default offers to go back to it, and range controls write on change rather than on release.",
  },

  // --------------------------------------------------------------- builds

  "builds-page": {
    problem:
      "Once there is more than one Tabby on the machine — the installed app, a source build, a frozen slot, an installer someone downloaded — nothing tells you which is which, which is running, which is stale, or what any of them cost on disk.",
    how:
      "Settings → <strong>Builds</strong> lists every one of them, with live process counts, memory and uptime; size on disk, build time, arch, branch and provenance. Two tabs: the list, with a kind filter and a cards/table switch, and Options. Discovery is one walk of the search roots that classifies each directory — checkout, application directory, or neither — and stops descending as soon as it knows, because a build holds three thousand files nobody needs to list.",
    settings: [
      { key: "builds.searchRoots", def: "['~/projects','~/Downloads','~/Tabby']", note: "Where to look. <code>~/Tabby</code> is a default because frozen slots live outside any checkout." },
      { key: "builds.searchDepth", def: "3", note: "How deep to descend before giving up." },
      { key: "builds.processPollMs", def: "3000", note: "How often running processes are re-read." },
      { key: "builds.pauseWhenUnfocused", def: "true", note: "Stop polling while the window is unfocused — it costs a subprocess." },
      { key: "builds.autoSize", def: "true", note: "Walk each build's size off the render path, one at a time, and cache it." },
      { key: "builds.autoDiagnose", def: "true", note: "Health-check each build on every scan." },
      { key: "builds.watchForNewBuilds", def: "true", note: "Offer to switch when a newer build appears." },
    ],
    notes: [
      "<strong>Processes are attributed by executable path</strong>, from one PowerShell call per poll. <code>tasklist</code> cannot report a path, and two builds both called <code>Tabby.exe</code> are otherwise indistinguishable. Linux reads <code>/proc</code> directly rather than spawning <code>ps</code>.",
      "<strong>Every <code>fs</code> call here goes through <code>original-fs</code></strong>, because Electron's patched <code>fs</code> mounts an <code>.asar</code> as a directory <em>and the first patched call on one opens the archive and keeps the handle for the life of the process</em>. Sizing a build is such a call, so every packaged build the page listed was pinned by the renderer itself — and Delete then died on the archive it had pinned. Measured: a single <code>lstat</code>, <code>stat</code>, <code>access</code> or <code>readdir</code> through the patched <code>fs</code> is enough, and only a process that never touched the archive can remove it.",
      "<strong>A Windows junction is not a directory to <code>lstat</code>.</strong> A slot's <code>data\\plugins</code> is a junction into the shared plugin directory; Node reports it as a symlink, so the size walk skips it and a delete unlinks it rather than following it. Verified on a decoy, and confirmed by arithmetic.",
      "<strong>Versions come from the executable's own version resource</strong>, not from a bundled plugin's <code>package.json</code> — that stamp goes stale, and the installed 1.0.230 here still carries a 1.0.197 plugin stamp.",
      "<strong><code>root</code> for a source build is <code>app/dist</code>, never the checkout.</strong> Delete means \"delete the build\", so it must not be able to mean \"delete the repo\".",
      "Delete on a running build quits it first with a WM_CLOSE so the app can save state, forces only after a grace period, and never offers to delete the build this window is running from.",
      "Arch is read out of the PE header, except for installers: an NSIS stub is a 32-bit executable whatever it installs, so there the file name wins.",
    ],
  },

  "builds-doctor": {
    problem:
      "An auto-update applied while the old version was running, deleted nine of the twelve directories under <code>resources/builtin-plugins</code>, and left the app starting to a splash screen for ever — with Windows reporting the process as responding the whole time.",
    how:
      "Each build is health-checked on every scan, and one that will not start says why on its own card. The symptom is read from the window title and the cause is found on disk.",
    notes: [
      "<strong><code>Responding</code> and <code>IsHungAppWindow</code> do not catch a boot that stalled.</strong> The window pumps messages perfectly; it just never rendered. Measured on the real failure: responding <code>True</code>, 6.5s of CPU across 37 minutes.",
      "<strong>The main window title is the signal that does.</strong> A booted Tabby titles its window after the active tab; one still on the splash is called <code>Tabby</code>. No cooperation from the app required, so it works for stock builds too. Past a 30s grace period, that is stuck at boot.",
      "<strong><code>fs.access</code> lies about <code>app.asar</code>.</strong> Electron mounts the archive as a directory, so <code>access()</code> answers ENOENT for a file that is plainly there while <code>stat()</code> calls it a directory. Ask the parent's directory listing instead — this produced a false \"bundle is missing\" on every packaged build until it was caught in testing.",
      "A builtin copied into the <em>user</em> plugin directory is reported too: a second <code>tabby-core</code> on the module path loads a second Angular and breaks dependency injection.",
      "Verified by reproducing the fault — a copy of a slot with <code>tabby-local</code> deleted, launched, and confirmed to be reported as \"will not start\" with both the cause and the symptom, while every healthy build stayed clean.",
    ],
  },

  "build-slots": {
    problem:
      "Testing a change means running a build beside the Tabby holding your live sessions. Doing that from a checkout means the two fight over the global hotkey, the MCP port and the config directory — and a build cut from a moving tree cannot be trusted to still be the thing you tested.",
    how:
      "<code>scripts/make-slot.mjs</code> builds a frozen, self-contained copy into <code>~\\Tabby\\builds\\</code>: its own portable <code>data\\</code>, plugins shared through a junction, app files marked read-only so a slot cannot drift after it is cut. There are exactly two — <strong>canary</strong> is disposable and every build replaces it; <strong>dev</strong> is the one you work in and changes only by promoting the canary you actually tried.",
    steps: [
      "<code>node scripts/make-slot.mjs</code> — build and install canary.",
      "Use it. When it is good: <code>node scripts/make-slot.mjs --promote</code> — copy canary into dev.",
      "<code>--dry-run --skip-build</code> prints what it would do, including which profile it would seed from.",
    ],
    notes: [
      "<strong>Promotion copies the canary that was built and tried, never a fresh compile.</strong> Otherwise \"promote what I verified\" would quietly mean \"build something new and call it verified\". Dev's <code>BUILD-INFO.txt</code> is canary's with a <code>Promoted:</code> line, so dev can never claim a commit that was not in its binaries.",
      "<strong>A slot that is running is never replaced</strong>, and the check is on that slot's own path rather than \"any Tabby\" — the point of two slots is that the other one keeps running while you rebuild this one.",
      "<strong>Rebuilding a slot keeps its <code>data\\</code>.</strong> A genuinely new slot seeds from the <em>other</em> slot, and from the installed app's profile only when there is no other slot at all. The choice is printed.",
      "The seeded profile drops the global toggle hotkey and blacklists the MCP server, because a slot runs beside your Tabby: otherwise whichever instance starts first takes both and the other silently half-works.",
      "Anything under <code>~\\Tabby\\builds\\</code> that is neither slot is pruned on every run — unless it is running, in which case it is reported and left. That is what makes \"only ever two\" structural rather than a habit.",
    ],
    caveats: [
      "<strong>The first version of <code>freeze()</code> froze <code>data\\config.yaml</code> too</strong>, and a read-only config file makes a slot lose every settings change <em>in silence</em>: the config write is an atomic rename, which is <code>EPERM</code> over a read-only file on Windows, so the save throws before the change event fires. Nothing persists, and nothing driven by that event re-applies either — so theme, spaciness and docking appear to do nothing at all while you are still in the window. <code>freeze()</code> now skips <code>data</code> by name and the script asserts the config is writable before reporting success.",
      "<strong>The naming scheme was replaced.</strong> Slots used to be <code>&lt;version&gt;-&lt;MMDD&gt;-&lt;HHmm&gt;-&lt;sha&gt;</code> directories, one per build, which accumulated until somebody noticed the disk — and every slot on the machine at the time was stale enough to hang, so what piled up was three copies of a trap.",
      "<code>cpSync</code> carries the read-only bit, so promoting a frozen canary lands frozen files in dev and the very next write fails <code>EPERM</code>. Attributes are cleared after the copy as well as before it.",
    ],
  },

  "active-build": {
    problem:
      "With several builds on the machine, \"the Tabby you use\" is whatever the taskbar pin happens to point at — and nothing stopped you deleting it.",
    how:
      "Exactly one build is <strong>active</strong>. It is what the pin launches, it carries a badge, and it is never deletable — so together with \"the build this window runs from is never deletable\", you must hand the crown to another build before you may delete this one. There is always a working Tabby left on the machine.",
    notes: [
      "<strong>Nothing here can create a taskbar pin.</strong> Windows removed the \"pin to taskbar\" shell verb in 1809 and blocks it for automation. What a pin <em>is</em>, though, is a shortcut in the Quick Launch user-pinned folder, and rewriting its target is allowed — so: pin Tabby by hand once, and the page keeps that pin aimed at the active build.",
      "<strong>What you pin is a Start menu entry, and that part can be created.</strong> Windows offers Pin to Start and Pin to taskbar only for things it considers Start menu apps, which is what \"I can't pin my fork\" turned out to be. Builds → Options writes one.",
      "<strong>One stable shortcut name, never the build's.</strong> Pinning <em>copies</em> the file, so a name that changed with the active build would strand every pin made from it.",
      "<strong>On first run the page adopts whatever the pin already points at</strong>, rather than nominating a build and overruling the desktop.",
      "<strong>A source build can be pinned because of <code>--dev</code>.</strong> A <code>.lnk</code> cannot carry environment variables, and dev mode was previously only expressible as <code>TABBY_DEV=1</code>, so the shortcut would have started an Electron with no plugins.",
      "The icon is rewritten with the target — and for a source build it comes from the checkout's own <code>.ico</code>, since the target there is <code>electron.exe</code>, whose icon is Electron's.",
    ],
    caveats: [
      "Putting an app in someone's Start menu because they clicked \"make active\" is not this page's call, so the shortcut is retargeted only when it already exists.",
    ],
  },

  "upstream-page": {
    problem:
      "\"Should I sync?\" is a question about a repository, asked from inside an application, and answering it meant leaving the window for a shell.",
    how:
      "Settings → <strong>Upstream</strong> compares this checkout against the project the fork tracks: how many commits have landed there that are not here, the patch series carried on top, and where each commit is on the web.",
    settings: [
      { key: "upstream.repositoryPath", def: "''", note: "Point at a checkout explicitly. Empty walks up from the executable." },
      { key: "upstream.remote", def: "'upstream'", note: "Which remote is the project being tracked." },
      { key: "upstream.branch", def: "'master'", note: "Which branch of it." },
    ],
    notes: [
      "<strong>It never fetches on its own.</strong> Network I/O when a settings page opens is how a page earns a reputation for being slow — fetching is a button. Which makes the staleness the thing that has to be visible: the last-fetch time is shown, warned about past a week, and the page says outright that it is reporting what was last fetched rather than what upstream has now. \"0 behind\" from a month-old fetch looks identical to a fresh one otherwise.",
      "<strong><code>FETCH_HEAD</code>'s mtime is when the fetch happened</strong>; the ref's own mtime is when it last <em>moved</em>, which is a different question and usually much older.",
      "Fields are split on <code>%x1f</code>/<code>%x1e</code> rather than a delimiter that could appear in a commit message.",
      "A missing <code>upstream</code> remote is the ordinary case for a fresh clone, so it is a message with the command to fix it, not an error.",
      "Verified against <code>git rev-list</code> on this checkout: behind and ahead counts, branch, the newest local subject and the resolved GitHub URL all match, and the Fetch button moves <code>FETCH_HEAD</code> in about 1.5s.",
    ],
    caveats: [
      "<strong>Only a source build has a checkout to find.</strong> A packaged build genuinely has none — the build sidecar records the commit but not where it was built — so that case is reported plainly, with a setting to point at a checkout anyway, rather than guessed at.",
    ],
  },

  // ---------------------------------------------------------- diagnostics

  "diagnostics-log": {
    problem:
      "A frozen window leaves no trace. Windows calls the process responding, nothing throws, no crash dump is written, and until now the app log had no timestamps to line anything up against. \"It hung again\" was unanswerable after the fact.",
    how:
      "<code>app/lib/diagnostics.ts</code> records what blocks an event loop, in the main process and in every renderer, to <code>&lt;config dir&gt;/diagnostics.log</code> as JSONL. Every synchronous <code>fs</code> and <code>child_process</code> method is wrapped and counted; stacks are sampled every 500 calls and deduplicated, so a burst is attributed without paying for a capture on each one. The summary line is usually the whole answer.",
    sample: {
      label: "A real stall record, summarised",
      text: "renderer event loop blocked 71.3s during \"ready\" — 98% synchronous I/O:\nfs.readFileSync ×58214 (41.0s), fs.unlinkSync ×58214 (28.2s)",
    },
    settings: [
      { key: "TABBY_DIAG", def: "1", note: "Environment variable. <code>0</code> disables the lot." },
      { key: "TABBY_DIAG_STALL_MS", def: "250", note: "How long a block has to last to be a stall." },
      { key: "TABBY_DIAG_INSTRUMENT_IO", def: "1", note: "<code>0</code> keeps the stall detector without the per-call I/O tally." },
    ],
    notes: [
      "<strong>The tally is the point, not a slow-call threshold.</strong> What freezes this app is tens of thousands of individually-fast synchronous calls — draining a spool directory, walking a build tree — where no single call would trip a \"slow call\" limit but the sum blocks the UI for minutes.",
      "<strong><code>syncMs</code> versus <code>ms</code> decides where to look.</strong> A stall that is mostly synchronous I/O names its own fix; one with almost none is script or GC, and no amount of I/O detail would have helped.",
      "<strong>It installs before zone.js and the plugin loader.</strong> The detector runs on timers captured before zone.js patches them — a zone-patched interval would schedule a change-detection pass every tick, and would stop reporting at exactly the moment the zone is what is wedged.",
      "<strong>The <code>fs</code> wrapper must go on the module <code>require</code> returns.</strong> <code>import * as fs</code> compiles to a copy whose properties are forwarding getters; assigning a wrapper onto that throws straight into our own catch and instruments nobody, with reports still arriving and attribution always empty.",
      "<strong>Records are size-capped by dropping whole fields, never by cutting the string.</strong> A JSONL log whose long lines do not parse is worse than one that admits it left something out. Lines stay around 1 KB, inside the size where an append from several processes still lands atomically.",
      "Writes are buffered and asynchronous: an instrumentation that blocks the loop to report that the loop was blocked would be measuring itself. Overhead is two <code>performance.now()</code> calls and a map lookup per synchronous call, about 200ns.",
      "Also recorded: <code>render-process-gone</code>, <code>child-process-gone</code>, per-window <code>unresponsive</code> with how long it lasted, renderer <code>unhandledrejection</code>, main <code>uncaughtException</code>, and boot phase marks so a stall says what was in progress when it hit.",
    ],
    caveats: [
      "<strong>Two known offenders it has already named are still unfixed at the source.</strong> A plugin's spool drain does uncapped synchronous <code>readdirSync</code>/<code>readFileSync</code>/<code>unlinkSync</code> on the renderer thread, and its hook writes one file per event and never prunes — so the backlog is proportional to how long Tabby was <em>not</em> running: measured 0.126 ms/file warm, and a 3.5-day gap is about 60,000 files. And a cold main process blocked <strong>17.4s</strong> during startup on module loading alone.",
      "It runs on the event loop it is measuring, so a wedged <em>main</em> process is beyond it by construction.",
    ],
  },

  "require-failed": {
    problem:
      "<code>tabby-electron</code> alone has seven <code>try { var wnr = require(…) } catch { }</code> blocks, and the plugin loader has its own. A module that failed to resolve left no trace and surfaced later as something unrecognisable — the documented case being a missing <code>windows-process-tree</code> presenting as <code>Cannot read properties of undefined (reading 'getRegistryKey')</code>, with nothing about process-tree anywhere.",
    how:
      "<code>Module._load</code> is wrapped, so the throw is seen before any of those catches swallow it. Nothing changes at the seven call sites, third-party plugin code is covered without its cooperation, and the error is always rethrown — this observes, it does not alter what happens next.",
    notes: [
      "Deduped by <code>request|code</code> and capped at 32 distinct, because a failing <code>require</code> is often <em>intentional</em>: optional dependencies and platform probes fail by design. One line per distinct thing that could not load, not one per attempt.",
      "Records the requesting file, so the answer is \"which package asked\", and the boot phase, so a load failure lines up against the stall it caused.",
      "It immediately named a real one nothing had ever reported: <code>macos-native-processlist</code>, MODULE_NOT_FOUND, from <code>tabby-electron</code> during plugin loading — harmless on Windows, and previously invisible.",
      "<strong><code>module</code> must stay in the renderer webpack <code>externals</code></strong> — it is, beside <code>fs</code> — or <code>require('module')</code> resolves to a webpack shim, the wrapper never installs, and the whole thing silently does nothing.",
    ],
  },

  "render-timing": {
    problem:
      "The stall recorder covers the event loop. It says nothing about the other way a terminal feels slow: nothing blocks, the loop stays free, and the screen still lags — because frames are being dropped, or because xterm is taking a long time to parse and lay out what was written to it.",
    how:
      "<code>tabby-render-timing</code> is a builtin that times both and writes records into the same log. It is a <code>TerminalDecorator</code>, not an edit to the frontend — add-only, so it costs nothing at the next rebase, and it reaches any frontend exposing an <code>xterm</code> without knowing which. It wraps <code>xterm.write</code> and measures call → callback, which is the interval that matters: the caller's <code>await</code> returns long before the screen reflects anything.",
    sample: {
      label: "A render-timing record",
      text: "render-timing  frames: 327, slowFrames 3, jankFrames 2, worst 150ms, p50 8.3, p95 8.5\n               term1: 7 writes, mean 22.7ms, worst 81ms, 2 slow",
    },
    notes: [
      "<strong>Tallied, never streamed.</strong> A busy terminal writes thousands of times a second; the finding is a distribution.",
      "<strong>The rAF loop only runs while something is writing</strong>, and stops two seconds after. A permanent one would keep the compositor awake on an idle window — a poor trade for a diagnostic.",
      "<strong>Gaps over 500 ms are not counted as dropped frames.</strong> An idle tab produces one enormous gap, and counting it would make every summary look catastrophic.",
      "Reports only when there is something to say: a healthy hour writes no lines.",
    ],
    caveats: [
      "<strong>The first version reported nothing at all</strong>, because it used the diagnostics <code>note()</code> API — which only appends a breadcrumb shown as <em>context when a stall is reported</em>, and is invisible otherwise. <code>report()</code> was added alongside it for records that are the finding rather than context for one.",
    ],
  },

  // ----------------------------------------------------------- robustness

  "module-lookup": {
    problem:
      "<strong>A Tabby exports <code>NODE_PATH</code> to every shell it starts</strong> — its own builtin plugins, its <code>app.asar\\node_modules</code>, and the user plugin directory — and the module lookup <em>appended</em> its own paths to whatever it inherited. So a Tabby started from a terminal inside another Tabby resolved <code>tabby-core</code> to the <strong>other build's</strong> copy: two Angulars, and a boot that stops dead on the splash screen. Invisible in a packaged build, because there is no console to see it in.",
    how:
      "Ordering plus absolute paths: this build's paths go ahead of anything inherited, and the builtins that must not be got wrong are required from the build's own plugin directory by absolute path rather than by name.",
    notes: [
      "<strong>The symptom is an idle process, not a busy one.</strong> Measured on the real failure: the renderer sat at 94 MB and 0% CPU for five hours, window titled <code>Tabby</code>, nothing in the app log after renderer start. <code>diagnostics.log</code> had the answer in one line — <code>require-failed</code>, <code>tabby-local</code>, MODULE_NOT_FOUND — plus a sampled 203 ms read of a <code>tabby-core</code> inside the user plugin directory, which is a path no healthy build should ever read.",
      "<strong>A stale copy of a builtin in the user plugin directory does the same.</strong> Three of them were there, pulled in by a third-party plugin listing <code>tabby-core</code>/<code>tabby-settings</code>/<code>tabby-terminal</code> under <code>dependencies</code> rather than <code>peerDependencies</code>. Plugin <em>discovery</em> already skipped such copies; nothing stopped <code>require</code> finding them first.",
      "<code>+=</code> on an unset <code>NODE_PATH</code> also left a literal <code>\"undefined\"</code> entry on the path, for years.",
      "The test resolves the four builtins under each poisoned environment and asserts they all come from the build itself — and also asserts the <strong>old</strong> ordering still fails, since a green run on a clean machine would otherwise prove nothing.",
    ],
    caveats: [
      "<strong>Relaunching does not clear it.</strong> The single-instance lock hands the launch to the poisoned process, which opens another window that never boots either — which is what \"it's still hanging\" turned out to mean. That instance has to be closed first. The watchdog exists because of exactly this.",
    ],
  },

  "watchdog": {
    problem:
      "Exactly one process answers for the app. Once that process cannot show a window, every later launch is handed to it and silently swallowed — no window, no error, no crash, indefinitely. <strong>Six hours of it, measured.</strong> Nothing anywhere checked that the lock holder had ever produced a working window.",
    how:
      "<code>app:ready</code> is the only line that matters. It is sent once the Angular root exists in a renderer, and everything that can open a tab or spawn a PTY lives at or after that point — so a process in which no window has ever emitted it has never run a session and holds nothing to lose. The first one disarms the watchdog permanently for the life of the process. That single rule is what makes code that can call <code>app.exit()</code> safe to ship.",
    settings: [
      { key: "TABBY_WATCHDOG", def: "1", note: "Environment variable. <code>0</code> disables it." },
      { key: "TABBY_WATCHDOG_BOOT_MS", def: "60000", note: "How long a window gets to reach <code>app:ready</code>." },
      { key: "TABBY_WATCHDOG_NO_WINDOW_MS", def: "5000", note: "How long the process may have no window at all." },
    ],
    notes: [
      "Two failure shapes, needing different tests. <strong>No window at all</strong> — a creation that threw, or a handoff that produced nothing, since the paths that call <code>newWindow()</code> have no catch and the failure simply vanishes. And <strong>a window that never booted</strong> — the one that actually bit, and the half a zero-window check cannot see, because the window is pushed onto the list <em>before</em> its readiness is awaited, so from outside nothing looks wrong.",
      "<strong>The boot budget is spent in ticks of a live event loop, not wall clock.</strong> A main process blocked for 19.7s during startup is measured on every cold launch here — it has not given the renderer that time, and burning the budget on it would quit a build that was only slow. Measured margin: a healthy dev build reaches <code>app:ready</code> 1.3–3.8s after the watchdog arms.",
      "<strong><code>app.exit()</code>, never <code>app.quit()</code>.</strong> The window's own close handler asks the renderer to confirm; a renderer that never booted never answers, so quitting politely would hang in exactly the place we are escaping.",
      "<strong>It writes to both logs before exiting.</strong> <code>diagnostics.log</code> batches behind a one-second timer and <code>app.exit()</code> runs no timers, so the flush is synchronous — otherwise the one record explaining the exit is the one record guaranteed to be lost.",
      "A <code>window-ready</code> record is now written on every successful boot, with how long it took. \"How long does this build take to start?\" was previously unanswerable from outside the process.",
    ],
    caveats: [
      "<strong>The original reproduction no longer reproduces.</strong> A poisoned <code>NODE_PATH</code> was the fault this was written for, and the module-lookup fix landed first — a dev build launched with the installed app's plugin directories on its path now boots in under two seconds. The test blacklists a required builtin instead, which lands in the same state. Like the module-lookup test it also runs the fault with the watchdog disabled and asserts it <em>still</em> hangs, because a fixture that quietly stopped reproducing would turn the whole run green.",
      "<strong>A wedged main process is beyond this by construction</strong> — the watchdog runs on that loop.",
    ],
  },

  "fatal-startup": {
    problem:
      "<code>dialog.showErrorBox</code> is <strong>modal and synchronous</strong>: the main loop stops inside it until someone clicks OK. Measured — a process showing one ran <strong>not a single timer callback in fourteen seconds</strong>. So a startup error left a process alive, with no window, holding the single-instance lock, unable to run the watchdog that exists for exactly that; and on an unattended launch nobody ever saw the box. This is the third hostage shape, and it is what made the other two unreachable.",
    how:
      "Four rules, in this order. <strong>Record before anything else</strong> — the failure to both logs, then a synchronous flush, because <code>app.exit()</code> runs no timers. <strong>Release the single-instance lock before saying a word</strong>, so the hostage property is closed by one call rather than by everything after it going right. <strong>Never block the loop</strong> — <code>dialog.showMessageBox</code> runs its dialog on its own thread and answers with a promise. <strong>Don't decide the exit here</strong>: whether there is anything worth keeping is the watchdog's question, and it already answers it carefully.",
    sample: {
      label: "Measured before and after, on a window construction that throws",
      text: "the failed launch    before: still there at 19s, nothing logged\n                     after:  exits itself in 5.3s, exit 1\n\nthe launch after it  before: handed to it, exit 0 after 1.3s, no window\n                     after:  its own process, app:ready in 1.7s\n\nunparseable config   before: modal, forever, invisible\n                     after:  exits in 1.2s, record flushed",
    },
    settings: [
      { key: "TABBY_FATAL_DIALOG", def: "1", note: "Environment variable. <code>0</code> skips the dialog outright." },
      { key: "TABBY_FATAL_DIALOG_MS", def: "120000", note: "How long the dialog may stay up before the process gives up on an answer." },
    ],
    notes: [
      "<strong><code>--hidden</code> is the only certain \"nobody is watching\".</strong> Nothing on Windows separates a double-click from a startup item, so the box is shown by default and skipped only where the answer is known: a launch that asked for no window at all. Nobody loses the error that way — a hidden Tabby that failed to start is one the user launches again the ordinary way, and that launch is not hidden, with both logs already written.",
      "<strong>Before <code>app.ready</code> the blocking box is still the only one available</strong>, so a config that will not parse gets <code>showErrorBox</code> — tolerable there and nowhere else, because the single-instance lock has not been requested yet, so that process is holding nothing.",
      "Handing the exit back to the watchdog also means a failure at the <em>tail</em> of startup no longer kills a window that had already reached <code>app:ready</code>.",
      "The attended checks are opt-in, because they put a real dialog on the screen. They read the box's own title from outside and then let it hit the cap: a timer firing while the box is up is the proof that it is no longer blocking.",
    ],
    caveats: [
      "<strong>The documented lever no longer throws.</strong> A geometry file with non-numeric bounds is now cascaded past rather than fatal, so the test reaches the same code path by other means — a <em>directory</em> where the file should be, which reads as EISDIR: neither ENOENT nor a syntax error, so it rethrows from inside the same constructor.",
      "<code>report()</code>'s detail must not carry a <code>kind</code> field — it is spread over the record after its own kind, so the record silently files under the other name. Cost a round trip.",
    ],
  },

  "config-save": {
    problem:
      "A config file that could not be written threw before the change event fired. Nothing persisted, and nothing driven by that event re-applied either — so theme, spaciness and docking appeared to do nothing at all, in silence, while you were still in the window. The real-world cause was a read-only <code>config.yaml</code> in a mis-frozen build slot.",
    how:
      "A failed save is reported rather than dropped, so the window says the setting did not stick instead of pretending it did.",
  },

  "cdp-safety": {
    problem:
      "<strong>A hardcoded debugging port is a live hazard, not a style problem.</strong> Chromium does not report a <code>--remote-debugging-port</code> it could not bind — it just does not listen, and every request then goes to whatever <em>is</em> on that port. Measured here: a test that assumed a port attached to the user's own Chrome, full of logged-in tabs, and only a URL filter stopped it evaluating JavaScript in them.",
    how:
      "Every CDP test in the repo goes through one driver. <strong>The port is found, never assumed</strong> — the hidden launcher picks a free one, records it, and removes the record on exit; a test reads that, sweeps a range if there is nothing registered, and refuses ambiguity rather than guessing between two instances. There is deliberately no fallback constant. <strong>Nothing is attached to until <code>/json/version</code> answers with JSON that names Electron</strong> — a browser answers there too, with <code>Chrome/…</code>, and is refused.",
    notes: [
      "So is a port answering HTML, and one that accepts the connection and then says nothing — which is what two ports on this machine do, because a service forwards them from WSL. Hence a 1.5s probe timeout; without it the whole suite waits on the OS.",
      "The negative tests run against HTTP servers the suite owns. <strong>Never point a negative test at a real browser.</strong>",
      "<strong>A failing CDP test has to exit.</strong> An open CDP socket holds the event loop, so a <code>catch</code> that sets <code>process.exitCode</code> without closing it leaves the process alive for ever — one test was measured at over 90s and still going, against 11s now. A test that reports by exit code ends by closing everything, and the driver settles every pending request both when the target goes away and when it simply never replies.",
      "<code>CDP_PORT</code> names an instance; it vouches for nothing.",
    ],
  },
};
