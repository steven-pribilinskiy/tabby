# Tabby fork — working notes

This is **steven-pribilinskiy/tabby**, a personal fork of [Eugeny/tabby](https://github.com/Eugeny/tabby)
that is **run from source locally**. It is not built into an installer and is not
distributed. The point of the fork is to carry local fixes without waiting for
upstream to merge PRs.

## Goals

- **Run locally from source**, with local changes applied. Never build the installer
  (`scripts/build-windows.mjs`, electron-builder) — it is not needed and is slow.
- **Stay close to upstream** so pulling in new upstream work stays cheap.
- Land fixes here first; upstreaming them is optional and never a blocker.

## Branch strategy

| Branch | Contents | Rule |
|---|---|---|
| `master` | Pure mirror of `upstream/master` | **Never commit here.** Only fast-forward. |
| `local` | `master` + our patch series | All local work goes here. |

`master` stays pristine so syncing is always a conflict-free fast-forward, and
`git diff master..local` is exactly "our changes" at any moment.

To sync:

```bash
git fetch upstream
git checkout master && git merge --ff-only upstream/master && git push origin master
git checkout local && git rebase master        # replay our patches on top
git push --force-with-lease origin local
```

Keep the patch series **small and one-concern-per-commit** — each commit is replayed
individually on rebase, so a fat commit means a fat conflict. Prefer adding new files
over editing upstream ones where there's a choice; add-only files never conflict.

**Prefer rebasing onto upstream over cherry-picking from it.** Cherry-picking upstream
commits into a diverged base duplicates commits, and the duplicates collide the next
time you rebase. Reserve cherry-picks for the case where a specific upstream fix is
needed *before* the next sync — and drop it at the following rebase, since it arrives
on its own.

Upstream release cadence, measured (2026-08): irregular. Gaps between the last 15
releases ranged 3–135 days; `master` averaged ~52 active days/year in bursts (median
3 days between active days, max gap 30). Syncing per upstream release tag is the
natural rhythm — roughly 6–14 times a year.

## Building and running locally

Prereqs on this machine: VS 2022 Build Tools (VC x86/x64 toolset v143), Rust +
`x86_64-pc-windows-msvc`, Python 3.13, `yarn` 1.x, `node-gyp`. Node v25 works; CI uses 22.

```bash
yarn --network-timeout 1000000     # postinstall: patch-package, install-deps, build-native
yarn run build                     # typings + webpack for app and all tabby-* packages
node scripts/prepackage-plugins.mjs
```

### Launching — two gotchas that cost real time

Run the dev build **only** with an isolated profile and a scrubbed environment:

```bash
PROFILE='<scratch>/tabby-profile'
NODE_PATH='C:\Users\steve\projects\tabby\app\node_modules' \
TABBY_PLUGINS= TABBY_DEV=1 TABBY_CONFIG_DIRECTORY="$PROFILE" \
  ./node_modules/electron/dist/electron.exe --user-data-dir="$PROFILE" app --enable-logging=stderr
```

`--dev` is equivalent to `TABBY_DEV=1` and can be used instead — it exists so a
source build can be started from a Windows shortcut, which cannot carry
environment variables. `TABBY_CONFIG_DIRECTORY` follows `--user-data-dir` when
unset, so `electron.exe --dev --user-data-dir=<profile> app` is a complete
launch on its own.

1. **`--user-data-dir` must come BEFORE the app path.** After it, Electron hands the
   switch to the app instead of Chromium and it is silently ignored — the dev build
   then shares `%APPDATA%\tabby` with the installed Tabby.
2. **Scrub the inherited `NODE_PATH`.** A shell started *inside* Tabby inherits
   `NODE_PATH` pointing at the **installed** app's `resources\builtin-plugins`,
   `app.asar\node_modules` and `%APPDATA%\tabby\plugins\node_modules`, plus
   `TABBY_CONFIG_DIRECTORY`. `findPlugins()` reads `nodeModule.globalPaths`, so the dev
   build loads the *installed* app's plugins against this repo's `tabby-core` →
   `NullInjectorError: No provider for ShellProvider!`. Point `NODE_PATH` at this
   repo's `app/node_modules` — not empty (plugins need `windows-native-registry` etc.
   from there) and not inherited.

Never launch without the isolated profile: the real Tabby holds live Claude Code
sessions, and Electron's single-instance lock is keyed on the userData dir.

### Verifying without a GUI

`ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe script.js` runs
Electron as plain Node — no window, but the correct native ABI. Use it to check that
native modules load, instead of launching the app and stealing focus.

### A CDP test must prove what it attached to

**A hardcoded debugging port is a live hazard, not a style problem.** Chromium does
not report a `--remote-debugging-port` it could not bind — it just does not listen,
and every request then goes to whatever *is* on that port. Measured here: a test
that assumed 9251 attached to the user's own Chrome, full of logged-in tabs, and
only a URL filter stopped it evaluating JavaScript in them. Probing whether a port
is free beforehand does not help; the collision is with something that binds it
first, or that was there all along.

So every `*.cdp.js` in this repo goes through `scripts/dev/cdp.cjs`, and:

- **The port is found, never assumed.** `scripts/dev/launch-hidden.mjs` picks a free
  one, records it under `%TEMP%\tabby-cdp\<port>.json`, and removes it on exit; a
  test reads that, sweeps `9230-9280` if there is nothing registered, and refuses
  ambiguity rather than guessing between two instances. There is deliberately no
  fallback constant. `CDP_PORT` names an instance; it vouches for nothing.
- **Nothing is attached to until `/json/version` answers with JSON that names
  Electron.** A browser answers there too — with `Chrome/…` — and is refused. So is
  a port answering HTML, and one that accepts the connection and then says nothing,
  which is what 9223/9224 do because svchost forwards them from WSL (hence a 1.5s
  probe timeout; without it the whole suite waits on the OS).
- `scripts/dev/cdp.test.cjs` asserts each refusal against HTTP servers it owns.
  Never point a negative test at a real browser.

**And a failing CDP test has to exit.** An open CDP socket holds the event loop, so
a `main().catch(…)` that sets `process.exitCode` without closing it leaves the
process alive for ever — `integrationsFreeze.cdp.js` did exactly that, measured at
`>90s` and still going, against 11s now. Two halves: a test that reports by exit
code ends `.finally(closeAll)`, and the shared driver settles every pending request
both when the target goes away and when it simply never replies (20s), because a
promise that does neither is the same hang one level down.

## NEVER kill the running Tabby

The installed Tabby runs live Claude Code agent sessions. **Never close, restart or kill
it.** The dev build runs as **`electron.exe`**; the installed app is **`Tabby.exe`** — so
`Get-Process electron | Stop-Process` is safe and `Get-Process Tabby` is off-limits.
Always verify after killing anything: `(Get-Process Tabby).Count` must be unchanged.

## Local patches

Two packages hardcode `SpectreMitigation` in their `binding.gyp` and fail to compile
with MSVC `MSB8040`, because the Spectre-mitigated VC libraries component is not
installed on this machine. Both are patched to drop it:

- `app/patches/node-pty+*.patch`
- `app/patches/@tabby-gang+windows-process-tree+*.patch`

**`@tabby-gang/windows-process-tree` is an `optionalDependency`, which makes its failure
silent** — yarn prints `info This module is OPTIONAL, you can safely ignore this error`,
drops the package, and exits 0. The app then boots to a *different* error, because
`tabby-electron/src/services/platform.service.ts` requires it and `windows-native-registry`
in the **same `try` block**: the first require throwing means `var wnr` is never assigned,
so the real symptom is `Cannot read properties of undefined (reading 'getRegistryKey')`
with nothing about process-tree anywhere. Every `wnr` require in `tabby-electron` is
`try { … } catch { }`, so resolution failures are invisible — instrument the catch before
theorising.

Chicken-and-egg on reinstall: yarn runs the package's own install script (which fails and
removes it) *before* `patch-package` can fix it. To restore it, extract the tarball
directly rather than installing:

```bash
npm pack @tabby-gang/windows-process-tree@0.6.1 --pack-destination <tmp>
tar -xzf <tmp>/*.tgz -C <tmp> && cp -r <tmp>/package app/node_modules/@tabby-gang/windows-process-tree
cd app && npx patch-package && cd .. && node scripts/build-native.mjs
```

**Never `npm install` in this repo.** It reconciles the yarn-managed tree to npm's layout
(observed: "added 104, removed 62, changed 27"), which leaves two copies of Angular and
breaks DI with `NullInjectorError: No provider for ShellProvider!` — a symptom that looks
nothing like its cause. Recover with `cd app && yarn`.

**Patch files must be written by hand.** `patch-package <pkg>` auto-generates garbage here:
it sweeps in `build/Release` binaries, `.obj` and `.tlog` files (2273 lines for node-pty).
Patches are also version-pinned in their filename — when upstream bumps either package,
regenerate or patch-package errors on the mismatch.

Do not commit `app/yarn.lock` churn. Yarn 1.x rewrites the aliased `string-width-cjs` /
`strip-ansi-cjs` entries on every install; `git checkout -- app/yarn.lock` after
installing. Upstream edits that file often, so local noise there causes sync pain.

## Claude Code integration (`tabby-claude`)

Claude session awareness is **built into the fork**, not a plugin: `tabby-claude/`
is a builtin package (listed in `scripts/vars.mjs`), so it ships inside a build slot
and is frozen with it. It provides a docked session panel and a tab hover card.

It rests on two new **generic** extension points in `tabby-core`, both add-only files:

- `SidePanelProvider` — contributes a panel to the dock host. The host
  (`sidePanelHost.component.*`) owns the header, edge picker and resize handle;
  `appRoot` places it with a **CSS grid area**, so moving a panel between edges
  never re-creates the component. `.window` keeps its original flex layout when no
  panel is shown, so the diff against upstream is one class binding plus one line.
- `TabHoverProvider` — contributes a rich hover card for a tab header, rendered
  through `tab-hover-host`. Falls back to the plain title tooltip when no provider
  applies. `isApplicable()` runs on every hover, so it must stay cheap.

**Data comes from stith** (`https://stith.lvh.me/api/{agents,waiting,usage}`), the
session registry — *not* from the hook spool. This is deliberate: the spool is
consume-and-delete, so a second reader would steal events from
`tabby-claude-status`, which still owns audio, tab decoration and session restore.
Reading stith means zero conflict and no plugin changes.

stith does not compute context-window usage, so that is derived locally from the
tail of the transcript JSONL (`transcriptMetrics.service.ts`). Transcripts reach
**160 MB**, so never read one whole — a 256 KB tail is enough, verified against
every live session. WSL transcripts are read over `\\wsl.localhost\<distro>\…`,
built from stith's `wslDistro`.

**Tabs are joined to sessions by directory**, never by PID: a Claude session in
WSL reports Linux PIDs that can never match Tabby's Windows conpty PIDs. Only an
unambiguous 1:1 pairing is trusted — a card on the wrong tab is worse than no
card.

Three things make that join work, each of which cost real debugging:

1. **The join key is the *launch* directory, not `cwd`.** A session's reported
   `cwd` comes from the hook payload, which follows every `cd` the agent makes
   through the Bash tool — measured live, 2 of 13 sessions had already drifted.
   Claude does record the launch directory, encoded into the transcript's
   project folder (`~/.claude/projects/C--Users-steve-projects/`). That encoding
   (`[\\/:]` → `-`) is lossy, so it is never decoded: the tab's directory is
   encoded the same way and the encoded forms compared, which is exact.
   Verified against the live registry — 11 of 13 reproduce, and the 2 that
   don't are exactly the drifted ones.
2. **The launch directory can be *recovered*** by walking the drifted cwd's
   ancestors until one encodes to the project key. `claude --resume` only finds
   a session from its launch directory, so this is what makes Resume work at
   all — see `ClaudeSessionsService.launchDirectory()`.
3. **`getWorkingDirectory()` alone never matches Windows tabs.** tabby-local
   deliberately returns null when the shell's live directory still equals the
   one it launched in (`tabby-local/src/session.ts`: "shell doesn't truly change
   its process' CWD") — i.e. the common case of opening a terminal in a repo and
   running `claude`. So `initialCWD` and the profile's cwd are used as
   fallbacks.

For WSL, `OSCProcessor` now parses **OSC 7** (`file://host/path`) as well as
iTerm's OSC 1337; OSC 7 is what default bash/zsh (including WSL's) emit, so
before this a WSL tab reported no working directory at all.

### Verifying the UI without stealing focus

Tabby's `--hidden` flag creates the window with `show: false` and skips
`focus()`, so the full renderer boots with nothing on screen. Combined with
`--remote-debugging-port` that allows rigorous verification while the machine is
in use — and CDP checks layout better than a screenshot: read
`getComputedStyle(...).gridTemplateAreas` and `getBoundingClientRect()` and
assert the panel and terminal tile without overlap.

```bash
NODE_PATH=<repo>/app/node_modules TABBY_PLUGINS= TABBY_DEV=1 \
TABBY_CONFIG_DIRECTORY=$P ./node_modules/electron/dist/electron.exe \
  --user-data-dir=$P --remote-debugging-port=9238 app --hidden
```

Gotchas found the hard way: a **second** dev instance on the same
`--user-data-dir` exits silently with code 0 (single-instance lock) — use a
separate profile. `window.ng.applyChanges(cmp)` is needed after poking a
component directly, since that bypasses the zone-patched listener that would
normally run change detection. And `app.tabs` holds `SplitTabComponent`
wrappers, not terminals — descend via `getAllTabs()`.

Verify the network path without a GUI — Node's fetch uses its own CA bundle, so
only a real renderer proves the mkcert cert is trusted:

```bash
./node_modules/electron/dist/electron.exe --user-data-dir=<scratch> fetch-test.js
# BrowserWindow({ show: false }) + webContents.executeJavaScript(fetch(...))
```

## Link tooltips and integrations (`tabby-links`)

A hover card over terminal links, a **Link Tooltip** settings page of rules that
customise it, and an **Integrations** page driven by declarative `integration.json`
manifests that fetch a preview for what a link refers to. Ported from the Windows
Terminal fork; `tabby-links/INTEGRATIONS.md` is the manifest spec, and the three
built-in manifests (Jira, Slack, stith) are kept interchangeable with that fork's.

The parts that cost real time:

- **Tabby's linkifier was broken for file paths and bare IPs.**
  `@xterm/addon-web-links@0.10.0` filters every match through an internal
  `isUrl()` (`new URL(text)` must parse), so `UnixFileHandler`,
  `WindowsFileHandler` and `IPHandler` never produced a clickable link. Our own
  provider vendors that addon's `LinkComputer` — the wrapped-line window and the
  early-wrapped-wide-char index correction are subtle and worth keeping verbatim —
  minus the filter, which fixes all three.
- **Two hover paths, not one.** xterm registers its own `OscLinkProvider` first
  and earlier providers win, so an OSC 8 link never reaches ours; it reaches
  `xterm.options.linkHandler`, which is *wrapped* rather than replaced (the
  linkifier writes it too, and only one of us can be last).
- **`provideLinks` must call its callback exactly once, on every path.**
  `OscLinkProvider` answers `[]` — truthy — so our links only ever arrive through
  the "every provider replied" pass. A provider that never calls back silently
  kills every provider after it.
- **We splice ourselves to index 1** in `_core._linkProviderService.linkProviders`
  rather than editing `tabby-linkifier`. Decorator order is plugin load order
  (alphabetical, so `linkifier` < `links`), and relying on that would have left
  `WebLinksAddon` shadowing us. Returning `[]` when the feature is off falls
  through to it cleanly, which is what makes the setting live with no re-attach.
- **Slack's `<uri|label>` is one match at a priority above every handler**
  (`delimitedLinks.ts`), not a change to any handler's regex. The Windows
  Terminal port this comes from (`c2dd09a42`) describes a bug that *does not
  exist here*: there `|` is inside the bare-URI character class, so the opener
  was handed `…/9962|repo#9962`; Tabby's `URLHandler` has no `|` in any of its
  classes and already stops at the pipe. What was actually missing is that the
  brackets and the label belonged to no link at all — measured before the fix,
  columns 0 and 33..43 of the construct resolved to `null`. So the delimited
  match has to *enclose* the bare one and take its cells, which is what
  `consider()`'s priority does; it ties with the text-rule tier deliberately, so
  a rule the user wrote for something in the label still wins. The URI is still
  shown in full — collapsing it to the label would mean the renderer showing
  text the buffer does not hold, which selection, copy, search and reflow all
  depend on.
- **The card is `position: fixed` but a DOM child of `.xterm-screen`.** It has to
  be a descendant or xterm's `xterm-hover` guard never applies and `mouseleave`
  clears the link the instant the pointer reaches the card; it has to be fixed or
  `.content { overflow: hidden }` clips it near a pane edge. The fixed containing
  block is not always the window (`app-root` has `will-change: transform`, a
  maximized split has `backdrop-filter`), so it is placed by measuring its own
  origin at `translate(0,0)` and then translating.
- **The card is bounded by the pane, not the window, and the cap comes before
  the measurement.** Clamping where an edge lands does nothing once the card is
  already wider than the pane it sits in — `linkTooltip.maxWidth` defaults to
  640px and knows nothing about how the window is split — so `position()` writes
  `--link-card-max-width`, the lesser of that setting and the hovered
  `.xterm-screen`'s own width, *before* it reads the card's size. The setting is
  an upper bound, never the width. CSS applies `min-width` after `max-width`, so
  the cap has to be spelled into both or `.link-card`'s 220px minimum quietly
  wins back the overflow in a narrow split.
- **Everything runs outside `NgZone`** — xterm's listeners are raw DOM. The card
  is created with `createComponent` + `ApplicationRef.attachView` (no
  `ViewContainerRef` exists in a decorator) and updated inside `zone.run`.
- **An `*ngFor` over a method that builds objects is an unbreakable freeze.**
  Clicking an integration wedged the whole window: the Integrations detail view
  iterated `fieldGroups(current)`, `*ngFor` tracks by identity, so every pass
  destroyed and re-created each `checkbox`, and every new `ngModel` queues the
  microtask that writes its value — which schedules the next pass. Measured at a
  full core and 500 MB and climbing, and **the inspector cannot interrupt it**:
  `Debugger.enable` gets no reply, exactly like the unicode-graphemes hang, so
  the stack has to be reasoned out rather than read. The derived arrays are now
  built once per selection. The hover card was only ever safe because its
  `*ngFor`s carry `trackBy: trackItem`, which returns the *index*.
- **The card is keyed on `(text, range)` and never rebuilt while it is open.**
  The Linkifier re-asks on every rendered-viewport change touching the hovered
  row, so during output that fires many times a second; rebuilding would strobe
  the card and restart its fetch every frame.
- **A rule pattern is a remotely triggerable freeze.** It runs synchronously on
  the mouse-move handler against text a remote host printed, and `(a+)+b` on
  thirty `a`s takes ~12 s. Patterns are probed at increasing input lengths and
  refused both on save and on compile, so a rule hand-written into `config.yaml`
  is covered. **The probe must escalate**: the first version used fixed 64-char
  inputs and took 127 seconds on `(a+)+b` — it reproduced the freeze it was
  meant to prevent. Measuring is also why the built-in handler regexes survive:
  they contain nested quantifiers and are fast, so a static syntax check would
  refuse Tabby's own defaults.
- **`safeStorage` cannot be driven over `@electron/remote`.** `encryptString`
  returns a Buffer, which crosses the bridge as a `Uint8Array`, and
  `decryptString` rejects a non-Buffer. `app/lib/secrets.ts` does the base64 in
  the main process so only strings cross. Credentials live in
  `<config dir>/integration-credentials.json`, never `config.yaml` — Config Sync
  uploads that file verbatim.
- **A `{}` config default silently discards writes.** `isStructuralMember` is
  false for an empty object, so `ConfigProxy` hands back a fresh `deepClone` on
  every read. The `integrations` map needs `__nonStructural: true`.
- **Bind settings inputs to the config, not to an `Integration` snapshot.**
  Snapshots are rebuilt on `config.changed$`, which arrives after
  `config.save()` resolves, so an input bound to one reverts characters while
  they are being typed.
- Open and Show in folder use `platform.openPath()` / `showItemInFolder()`, not
  `openExternal('file://' + p)` — that yields `file://C:\foo` on Windows and is
  an existing upstream bug in `tabby-linkifier/src/handlers.ts`.

### Rich integrations

The reference fork grew five manifest keys in `3f221ee31`, and a manifest using
them **degraded silently here** until this was done — which is the actual threat
to "one manifest, many terminals", far more than any cosmetic divergence.

- **`fieldGroups`** — named sets of display fields, with a heading on the card
  and a tri-state header checkbox in settings. Anything no group claims becomes
  an implicit unlabelled group shown *first*, so a manifest that groups only its
  secondary data still leads with its title.
- **`tabs`** — a description body or a comment list, behind a strip. `adf`
  (Atlassian Document Format) is flattened by walking the node tree; `markdown`
  is **parsed to data, never to HTML**, and the template renders blocks and
  inline spans through interpolation. This text is written by whoever opened the
  ticket, so there is deliberately nothing to sanitise.
- **`actions`** — the only part of this subsystem that *writes*. A `choice`
  resolves its options from an earlier step, applies one, drops the cached
  preview and re-fetches so the badge updates in place. Undo is offered only
  when some other option leads back to where you were — Jira workflows are
  frequently one-directional, and the card says nothing rather than offering an
  undo that would fail.
- **`detectPatterns`** — joined to the scan pool as *synthetic rules*, which is
  what makes them obey the 16-pattern cap, the ReDoS guard and first-match-wins
  without any of that being written twice. User rules are added first, so one the
  user wrote still wins.
- **step `optional`** — a failing step is recorded and stepped over. Jira's
  Development panel and GitHub's richer endpoints are permission-dependent, and a
  403 should cost that section, not the card.

`github.json` joins the built-ins; all four manifests are now byte-identical to
the reference's committed copies apart from Jira's two additive host keys and
stith's `html` block, and the test asserts that key by key.

Two things worth knowing:

- **`detectPatterns` is often belt and braces here.** Tabby's own URI detector
  already claims anything with a `scheme://`, so `stith://…` in plain output was
  hoverable before this. Measured, not assumed: two providers claim it, both as a
  *link*. It earns its keep on patterns that are not URIs.
- **A restored-but-never-rendered tab has a frontend and an `xterm` but no
  provider of ours.** Of six terminals in the scratch profile only two had the
  decorator attached, and a test that picks the first one makes a working
  detector look broken. Select on `decorator.states.has(tab)`.

### The `html` representation

A manifest may carry an `html` key — a complete HTML document, rendered in place
of the `fields` list, given `window.__data` (every fetch step's JSON, keyed by
step id) and `window.__uri`, and talking back over
`chrome.webview.postMessage` with `{height}` (clamped 40–320) or `{open}`.
`tabby-links/INTEGRATIONS.md` has the contract; `htmlHost.ts` builds the
document and `stith.json` is the worked example.

This is a **port of the Windows Terminal fork's contract, which that fork cannot
run**: its WebView2 host is compiled behind `Feature_HyperlinkPreviewHtml` with
no `WebView2Loader.dll` shipped, so `html` there always falls back to `fields`.
Both repos previously documented it as "reserved, not implemented in either
fork", which was wrong and cost a rediscovery.

- **`sandbox="allow-scripts"`, and nothing else, is the entire security story.**
  Tabby's renderer is `nodeIntegration: true`, `contextIsolation: false`
  (`app/lib/window.ts:77`) with **no CSP anywhere in the app**, so a plugin page
  that reached the parent realm would be `require('child_process')`, not XSS.
  Without `allow-same-origin` the frame is on an opaque origin and can do
  nothing but post a message. Verified live: `window.origin === 'null'`, no
  `require`, no `process`, and reading into the frame from the host throws
  `SecurityError`.
- **Angular refuses a *bound* `sandbox`** (NG0910) and is right to, so it is
  written out literally in the template. `HTML_SANDBOX` exists only so a test can
  assert the two have not drifted.
- **A CSP is injected ahead of the document** — `default-src 'none'`,
  `connect-src 'none'` — which the WebView2 host does not do. The page renders
  data already fetched and cannot call home. `img-src https:` is the one
  exception, for parity with `iconPath` on a `fields` card.
- **`srcdoc` is written only when the card's key changes.** Assigning it reloads
  the page and restarts its script, and the Linkifier re-asks many times a second
  during output.
- **A page cannot be verified in the hidden dev build.** Chromium throttles
  rendering for a cross-origin subframe that is never visible, so the frame's
  document is never laid out and *every* measurement inside it reads 0 — a
  `height: 77px` div included. `test/htmlPage.electron.js` gives the page its own
  window, shown without focus and off-screen, purely so a compositor runs.
- **Measure `document.body.scrollHeight`, not `documentElement`'s.** The latter is
  the frame's own viewport, so a page that reports it just asks to stay the size
  it already is — a silent no-op that looks exactly like a broken channel.

### Show in pane

A card button puts the same preview in a **real pane** beside the terminal —
grouped fields, markdown bodies, comments, actions and a plugin's own `html` —
with a switch that silences hover cards while one is open.

**This reverses a decision this fork had written down.** `htmlHost.ts` used to
say outright that "a plugin asking for 1000px does not get the pane", because
there was no pane. Half of that sentence was always about the card and still
holds: the card is a hover affordance, it is still bounded by the terminal pane
it floats over, and a page there is still clamped to 320px. The pane is the
opt-in place where a big preview is legitimate, and there a page may ask for up
to 4000px. That comment now says which host each limit belongs to rather than
stating a policy the code contradicts.

- **One renderer, in two hosts.** `linkPreviewView.component` is the whole
  preview — groups, the tab strip, markdown, comments, actions, the sandboxed
  frame — and the card and the pane each mount it. A second copy of that markup
  is exactly how the pane would end up less sealed than the card, so
  `logic.test.js` now also asserts that no other template in the package
  contains an `iframe` at all.
- **The only thing the pane passes it that the card does not is room**: a `pane`
  flag that swaps five CSS variables (body cap, options cap, two line clamps, an
  image cap) and a larger `maxHtmlHeight`. Everything else — `trackBy` on every
  `*ngFor`, markdown parsed to data and never to HTML, `srcdoc` written only
  when the key changes — is therefore stated once and true in both.
- **`ngAfterViewChecked` writes the frame**, not each host. The card called
  `syncHtmlFrame()` from its own `refresh()`; with two hosts that becomes two
  places to forget. A check whose key has not changed is one comparison.
- **The pane must be opened inside `NgZone`.** The card's buttons hang off
  xterm's own DOM, which is outside it, and `TabsService.create` +
  `SplitTabComponent.addTab` from outside the zone builds a tab nothing ever
  draws.
- **Settling a load must not happen during the pass that created the view.**
  `load()` finishes *synchronously* when no integration claims the link, so
  `ngOnInit` defers it by a microtask; otherwise its `detectChanges()` re-enters
  the pass that is still constructing the pane.
- **Suppression needs both halves** — `linkTooltip.hideTooltipsWithPane` *and* a
  pane open — which is what makes the switch safe to leave on: closing the last
  pane brings hover cards back without anyone having to remember to turn it off.
  It is asked in `onHover`, so a suppressed hover costs no timer, no `convert`
  and no rule resolution.
- **The pane takes the card's answers rather than resolving again.** The card
  already knows which buttons this link earned, which integration answered and
  what a `text` match resolved to; asking a second time can get a different
  answer, because a `text` match has no link until an integration says so.
- **A pane has no recovery token**, so it is not restored with the window. That
  is upstream's own path for a tab that cannot be recovered (`recoverContainer`
  skips a null child) and it leaves that container's ratios one entry long,
  which is an upstream bug affecting any such tab. Not worth a preview pane
  re-running someone's Jira fetch at boot.
- Verified in `tabby-links/test/pane.cdp.js` (40 checks): opened through a real
  hover and a real click on the card's button; the `html` frame in the pane on
  an opaque origin with no `require`, no `process`, the CSP present and the
  network refused; tooltips silenced and restored; and **change-detection
  passes over an idle pane counted — measured 0 over 2.5s** — because the
  `*ngFor` freeze does not fail a test, it hangs one.

### Click chords

What a click does is configurable: two chords, primary and alternative, each a
**modifier × gesture × action**, plus which kinds of link a click reaches at all
(`detected`, `rules`, `osc8`) and a master `linkTooltip.clickable`. A rule may
override either chord's action — `''` inherits, `'none'` suppresses.
`clickChords.ts` is the whole decision, kept pure so `logic.test.js` measures it.

- **`clickableLinks.modifier` is upstream's and is migrated, not dropped.** It
  may be in a real `config.yaml` — the Windows Terminal fork could retire its
  equivalent without a migration only because that one was in nobody's settings
  file. `LinkClicksService.migrateLegacyModifier()` moves the modifier onto the
  primary chord, silences the alternative (which defaults to Ctrl+click and would
  otherwise re-enable the very click the user turned off), and **clears the key as
  it reads it** — which is what makes it idempotent without a `config.version`
  bump. A fork-owned bump would make upstream's own migrations skip these configs
  at the next sync. It runs from `config.ready$` in the module constructor,
  because the decorator and the settings page only exist once you open a terminal
  or that page, and until it runs both settings are live and disagreeing.
- **Modifiers match exactly**, so a Ctrl chord does not fire mid-Ctrl+Shift-drag.
  The cost is that alt+click and shift+click no longer follow a link, which
  `!modifier` used to allow — both are selection gestures, and this is what
  Windows Terminal does.
- **Left resolves on release; middle and double resolve on the press.** A press is
  also the start of a selection drag, so a left chord has to wait and then refuse
  if a selection was made. The other two have something to beat on the same
  event: the terminal pastes on a middle *mousedown* (`baseTerminalTab`, via the
  frontend host, an ancestor of `.xterm-screen`), and a double press selects a
  word — waiting would mean the drag guard finding that selection and refusing.
  So `onPress` listens on `.xterm-screen` itself and `stopPropagation()`s, but
  **only once it knows an action will actually run**; a chord resolving to `none`
  leaves the press for whoever else wanted it.
- **A mousedown resets xterm's selection model**, which is what makes
  `hasSelection()` at mouseup mean "this press selected something" rather than
  "something is selected". The cell-distance check beside it is the second
  opinion.
- **xterm calls `activate` on *any* button's mouseup**, with no button check
  (`Linkifier._handleMouseUp`), so a middle release would fire a second time
  after the press already did. `activate` therefore handles left gestures only.
- **OSC 8 clicks are taken over, not forwarded.** `tabby-linkifier`'s own
  `linkHandler.activate` decides for itself from `clickableLinks.modifier`;
  leaving it in the wrapper would mean an OSC 8 link ignoring both the chords and
  the `osc8` filter, and opening twice whenever they agreed.
- **A press uses xterm's `currentLink` to decide there is a link under the
  pointer**, not our own `state.hovered` — that outlives the hover by the hide
  delay, so a middle click a moment after leaving a link would run against the
  link just left.
- **`state.settings` is dropped on every new hover.** It is the answer for the
  link just left, and a click on a second link on the same row beats the show
  delay easily — the click would otherwise inherit the neighbour's rule.
- `terminal.rightClick: 'menu'` (the Windows default) already treats ctrl+left as
  a right click, so the default alternative chord pops a context menu as well as
  following the link. Unchanged from before — `clickableLinks.modifier: null` had
  exactly the same overlap — but it is the reason `clicks.cdp.js` turns that
  setting off for its run.

### Fixed in the second pass

Each of these was shipped and wrong; they are listed because the shape recurs.

- **`fileTypeGroup` and `extensions` never matched.** `decorator.ts` passed `''`
  as the resolved path, and `linkRules.service.ts` requires a real one — so two
  controls in the rule editor did nothing at all. The rules are now asked twice:
  once for the show delay, then again once the path is known.
- **`lookupPath` tested for a colon before a leading slash**, so `/links/self:href`
  parsed as a step named `/links/self` and the field silently vanished.
- **`colorPath` vs `color` precedence was inverted** relative to the other fork,
  which breaks the one thing the format promises. The path wins; the literal is
  the fallback.
- **`cacheSeconds: 0` meant "cache for a second"**, not "never cache".
- **`fields: []` could not be expressed** — unticking the last display field
  sprang back to the manifest defaults, because empty and absent were the same
  value. `Integration.fields` is now `string[] | null`.
- **A `command` step merged stderr into stdout**, so any command that warns
  before succeeding failed to parse, reporting "produced no usable output" about
  output that was fine. Now separate, and any credential appearing in stderr is
  redacted — a failing command usually echoes the command line it was given.
- **An unconfigured integration lost Open / Copy link**: resolving `CAB-8209` to
  a URL needs only the matcher, not a credential. Only *previewing* needs one.
- The **punycode/IDN annotation was missing entirely** — a homograph warning the
  reference has and this port had silently dropped.

### Rule presets

Adding a Link Tooltip rule no longer starts with writing a regex: the "Add rule"
button is a split button whose caret offers eleven ready-made rules, and an
"Apply preset" dropdown inside the editor rewrites the open one.
`tabby-links/src/presets.ts` holds them.

- **A preset does not own its pattern.** Anything an integration already matches
  takes the pattern *from that manifest*, selected by running the manifest's own
  matchers against a canonical example the preset names. A hardcoded twin of the
  Jira key regex would be a second copy that drifts, and these manifests are
  asserted byte-identical to the Windows Terminal fork's, so they do move. The
  join fails safe: no matcher claims the example, or more than one does, and the
  preset is simply not offered. Only commit hashes, media files and source files
  — which no manifest describes — carry a pattern written here.
- Consequence: presets are **per matcher**, not per subject. The reference merges
  `pull|issues` into one preset and both stith forms into another; here they are
  five separate presets, because that is how the manifests are written.
- **Every preset must pass `regexGuard.checkPattern`** — one that the guard then
  refuses is a rule that silently never fires. `logic.test.js` times all of them
  through the guard and against adversarial input at 512 and 4096 characters
  (measured: worst 0.06 ms to check, 0.05 ms to match).
- `\b[0-9a-f]{7,40}\b`, the reference's commit-hash pattern, is carried here as
  `\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b`. Without the letter it demands, every
  seven-digit number in the output is a commit — PIDs, ports, epoch seconds — and
  a rule that decorates everything gets turned off.
- Applying a preset resets the delay/width overrides and the button suppression
  but **keeps custom actions**: they are the one part of a rule that is
  unambiguously the user's own work.

### WSL paths: the translation was right and unreachable

The `\\wsl.localhost\<distro>\…` translation was correct in isolation and never
ran, so a path printed by anything inside WSL had no Copy path, no Show in
folder, and a click that did nothing at all.

- **The order was backwards.** `decorator.ts` gated the whole thing on
  `handler.verify()`, which is `fs.access` on the string as written
  (`tabby-linkifier/src/handlers.ts:61`, and it ignores the tab it is handed).
  For `/home/you/notes.md` that asks Windows about `C:\home\you\notes.md`, which
  is false, so `resolve()` bailed before it could translate anything. Existence
  is now asked once, of the path that would actually be opened.
- **`verify` is not consulted at all any more**, rather than being fixed — it is
  upstream code, and every line changed there is rebase surface. Nothing is lost:
  it *is* the existence check, and it was being run on the wrong string.
- **What replaces it as the "is this a path" test is rootedness**, not existence.
  A text rule matches things like an issue key, and `fs.access('CAB-8209')` is
  answered against the app's own working directory, where it could plausibly
  exist. Anything not rooted is not asked about — which also drops the
  `fs.access` that every hovered `http` URL used to cost.
- **An OSC 8 `file://` link arrives with no handler**, so `isFileLike` was
  false and the `file://` branch of `resolve()` was dead code. That is the form
  Claude Code emits, and the one that carries a fragment.
- **`#L6-L7` is a fragment, not part of the name** (RFC 3986 §3.5), and it was
  carried into both the existence check and the share path. Stripped *before*
  percent-decoding, so a `#` genuinely in a filename — which has to arrive as
  `%23` — survives. Reference commit `c15aae37a`; GH#14116 has asked upstream
  for it since 2022.
- **The reference's UTF-8 escape handling has no analogue here.**
  `PathCreateFromUrlW` unescapes `%XX` a byte at a time and widens each byte
  alone, so `caf%C3%A9.md` arrives mojibaked; `decodeURIComponent` is already
  correct. It throws on a stray `%`, though, and that throw was reaching an
  unawaited `show()`.
- **`file://<authority>/…` is a UNC path**, which is how an editor writes a WSL
  link that already names its own distro. `/mnt/<letter>/` becomes the drive,
  since the share would answer for a file sitting on the local disk.
- **Clicking takes the new route only when translation changed the path.** A
  Windows path and an `http` link still go through the handler exactly as they
  did; asserted both ways in `tabby-links/test/wslPath.cdp.js`.
- Still wrong, and left alone: `~/notes` in a WSL tab is untildified to the
  *Windows* home by `BaseFileHandler.convert`, so it resolves to the wrong file
  if that path happens to exist. Fixing it needs the distro's home, which costs
  a `wsl.exe` spawn on a hover.

## Builds page (`tabby-builds`)

Settings → **Builds** lists every Tabby build on this machine: the installed
app, the webpack output this fork runs from, electron-builder output inside a
checkout, and installer files. Live process counts, memory and uptime; size on
disk, build time, arch, branch and provenance. Two tabs — the list (kind filter
+ cards/table switch) and Options.

The bits that cost real time:

- **Processes are attributed by executable path**, from one PowerShell call per
  poll (`Get-Process -Name Tabby,electron` → `.Path`). `tasklist` cannot report a
  path, and two builds both called `Tabby.exe` are otherwise indistinguishable.
  Linux reads `/proc` directly rather than spawning `ps`; the poll pauses while
  the window is unfocused, because it costs a subprocess.
- **Discovery is one walk of the search roots that classifies each directory**
  — checkout, application directory, or neither — and stops descending as soon
  as it knows, because a build holds three thousand files nobody needs to list.
  A **standalone application directory** (binary + `resources`) counts wherever
  it is: the frozen build slots under `~\Tabby\builds\` live outside any
  checkout, so nothing else would ever find them. A `data` directory beside the
  binary means portable, which is what lets a slot run alongside the installed
  app. `~\Tabby` is therefore a default search root.
- **A slot's `BUILD-INFO.txt` wins over its version resource.** Slot binaries
  report `1.0.0`; the sidecar carries the real version, the commit, the branch,
  the originating checkout and the upstream base it was forked from. Taking
  `builtFrom` from the slot and `head` from that checkout is what makes "this
  slot is behind the tree" visible.
- **A Windows junction is not a directory to `lstat`.** `data\plugins` in a slot
  is a junction into `%APPDATA%\tabby\plugins`; Node reports it as a symlink, so
  the size walk skips it and `fs.rm` unlinks it rather than following it —
  verified on a decoy, and confirmed by arithmetic (the slots differ by 52 files,
  not by the plugin directory's 289).
- **Every `fs` call here goes through `original-fs`** (`tabby-builds/src/nodeFs.ts`),
  because Electron's patched `fs` mounts an `.asar` as a directory *and the first
  patched call on one opens the archive and keeps the handle for the life of the
  process*. Sizing a build is such a call — `lstat` on `resources\app.asar` — so
  every packaged build the page listed was pinned by the renderer itself, and
  Delete then died on the archive it had pinned:

  ```
  EBUSY: resource busy or locked, rmdir '…\resources\app.asar'
  ```

  `rmdir` because the patched `lstat` calls the archive a directory; `EBUSY`
  because the handle is ours. Nothing could clear it — not `maxRetries`, not
  `process.noAsar` set afterwards, not `original-fs` at the delete site: measured,
  a *single* `lstat`, `stat`, `access` or `readdir` through the patched `fs` is
  enough, and only a process that never touched the archive can remove it. So the
  fix is upstream of the delete: nothing in this plugin may open an archive at
  all. `tabby-builds/test/asarDelete.cdp.js` asserts both halves — the patched
  `fs` still failing exactly that way on a control fixture, which is also what
  proves the fixture is an archive Electron recognises, and the real services
  sizing and deleting an untouched one.
- **Versions come from the executable's own version resource**, not from
  `resources/builtin-plugins/tabby-core/package.json` — that stamp goes stale
  (the installed 1.0.230 here still carries a 1.0.197 plugin stamp).
- **A source build's version and provenance come from `app/dist/build-info.json`**,
  a sidecar `app/webpack.config.mjs` writes next to the bundle. The DefinePlugin
  constants that feed the tab-bar build hint can only be read from *inside* a
  running instance; this page has to describe builds sitting on disk. A card
  reads `stale` when the checkout's HEAD has moved past what the bundle was
  compiled from.
- **`root` for a source build is `app/dist`, never the checkout.** Delete means
  "delete the build", so it must not be able to mean "delete the repo". It also
  removes the plugin `dist` dirs and `builtin-plugins` (`extraPaths`), which is
  the rest of what `yarn build` produced.
- **Delete on a running build quits it first** — `taskkill /PID /T` (a WM_CLOSE,
  so the app can save state), force only after a grace period, then the
  directory goes. The build the window is running from is never deletable.
- Arch is read out of the PE header, except for installers: an NSIS stub is a
  32-bit executable whatever it installs, so there the file name wins.
- Sizes are walked one build at a time off the render path and cached; symlinks
  are never followed, or `builtin-plugins` would count the same bytes twice.

### Cutting a slot

There are exactly **two** slots, after the model this machine's Windows Terminal
fork uses for `wtd` / `wtt` — and they are not two equivalent scratch installs:

| Slot | Directory | What it is |
|---|---|---|
| **canary** | `~\Tabby\builds\canary` | Disposable. Every build replaces it. The only slot the script will overwrite on its own. |
| **dev** | `~\Tabby\builds\dev` | Production — the Tabby you work in. Changes exactly one way: canary is promoted into it. |

```bash
node scripts/make-slot.mjs                 # build and install canary
node scripts/make-slot.mjs --promote       # copy canary into dev
node scripts/make-slot.mjs --dry-run --skip-build --seed-from <dir>
```

- **Two fixed names, not `<version>-<MMDD>-<HHmm>-<sha>` directories.** The old
  scheme accumulated one per build until somebody noticed the disk; worse, every
  slot on this machine at the time was stale enough to hang, so what piled up was
  three copies of a trap. Fixed names also retire the whole business of
  retargeting shortcuts — a slot's path never changes now, so a pin made once
  stays correct for ever, and `--activate` is gone with it.
- **Promotion copies the canary that was built and tried, never a fresh
  compile.** Otherwise "promote what I verified" would quietly mean "build
  something new and call it verified". `dev`'s `BUILD-INFO.txt` is canary's,
  with a `Promoted:` line — so dev can never claim a commit that was not in its
  binaries.
- **A slot that is running is never replaced.** The check is on that slot's own
  path, not "any Tabby" — the point of two slots is that the other one keeps
  running while you rebuild this one.
- **Rebuilding a slot keeps its `data\`.** Only application files are replaced,
  which is what makes settings survive a rebuild and is most of why the old
  seeding logic could go. A genuinely new slot seeds from the *other* slot —
  a new canary from dev, a new dev from the canary being promoted — and from
  `%APPDATA%\tabby` only when there is no other slot at all. Printed as `seed:`
  (in `--dry-run` too); `--seed-from <dir>` overrides it.
- **Anything under `~\Tabby\builds\` that is neither is pruned on every run**,
  unless it is running, in which case it is reported and left. That is what
  makes "only ever two" structural rather than a habit.
- `--dir` only — a slot is an unpacked directory, never an installer.
- **`cpSync` carries the read-only bit**, so promoting a *frozen* canary lands
  frozen files in dev and the very next write — `BUILD-INFO.txt` — fails
  `EPERM`. The attributes are cleared after the copy as well as before it;
  `freeze()` puts them back.
- The Builds page now reads every portable build's own `data\config.yaml`, not
  just the running one's, so **Delete says that the settings go with it**.
- The seeded profile drops `hotkeys.toggle-window` and blacklists `mcp-server`,
  because a slot is meant to run *beside* your Tabby: otherwise whichever
  instance starts first takes the global hotkey and the MCP port, and the other
  silently half-works.
- `data\plugins` is a junction to `%APPDATA%\tabby\plugins` so plugins stay
  shared and live. The Builds page knows not to follow it.
- App files are marked read-only, so a slot cannot drift after it is cut —
  **but `data\` must stay writable, and the first version of `freeze()` did not
  leave it that way.** `attrib +R <slot>\* /S /D` froze `data\config.yaml` too
  (`/D` does not exempt anything — it *adds* folders to what attrib touches), and
  a read-only config file makes a slot lose every settings change in silence:
  `app/lib/config.ts` writes through `atomically`, whose rename over a read-only
  file is `EPERM` on Windows, so `ConfigService.save()` throws before
  `emitChange()`. Both halves of that hurt. Nothing persists — and nothing driven
  by `config.changed$` re-applies either, so Spaciness, theme and docking appear
  to do nothing at all while you are still in the window. `freeze()` now skips
  `data` by name and `make-slot.mjs` asserts `data\config.yaml` is writable
  before it reports success.

### The doctor

Each build is health-checked on every scan, and a build that will not start
says why on its own card. Written after an auto-update applied while the old
version was running, deleted nine of the twelve directories under
`resources/builtin-plugins`, and left the app starting to a splash screen
forever — with Windows reporting the process as responding the whole time.

- **`Responding` / `IsHungAppWindow` do not catch a boot that stalled.** The
  window pumps messages perfectly; it just never rendered. Measured on the real
  failure: responding `True`, 6.5 s of CPU across 37 minutes.
- **The main window title is the signal that does.** A booted Tabby titles its
  window after the active tab; one still on the splash is called `Tabby`. No
  cooperation from the app required, so it works for stock builds too. Past a
  30 s grace period, that is *stuck at boot*.
- **The cause is found on disk, not in the process.** `tabby-core`,
  `tabby-settings`, `tabby-terminal`, `tabby-local` and `tabby-electron` are
  the builtins whose absence is fatal — each throws `Cannot find module` out of
  the plugin loader as an unhandled rejection that nothing catches.
- **`fs.access` lies about `app.asar`.** Electron mounts the archive as a
  directory, so `access()` on it answers ENOENT for a file that is plainly
  there while `stat()` calls it a directory. Ask the parent's directory
  listing instead — this produced a false "bundle is missing" on every
  packaged build until it was caught in testing.
- A builtin copied into the *user* plugin directory is reported too: a second
  `tabby-core` on the module path loads a second Angular and breaks DI.
- Verified by reproducing the fault — a copy of a slot with `tabby-local`
  deleted, launched, and confirmed to be reported as `will not start` with both
  the cause and the symptom, while every healthy build stayed clean.

### The active build and the taskbar pin

Exactly one build is **active** — "the Tabby you use". It is the build the
Windows taskbar pin launches, it carries an `active` badge, and it is never
deletable, so there is always a working Tabby left on the machine. Together
with "the build this window runs from is never deletable", that is the
guarantee: you must hand the crown to another build before you may delete this
one.

- **Nothing here can create a taskbar pin.** Windows removed the "pin to
  taskbar" shell verb in 1809 and blocks it for automation; `Tabby.exe` only
  offers *Pin to Start*. What a pin *is*, though, is a shortcut in
  `%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar`, and
  rewriting its target is allowed. So: pin Tabby by hand once, and the page
  keeps that single pin aimed at the active build.
- **What you pin is a Start menu entry, and that part *can* be created.**
  Windows offers *Pin to Start* and *Pin to taskbar* only for things it
  considers Start menu apps: `~\Tabby\Tabby-fork.lnk` was found by Start search
  but its context menu had nothing but Run as administrator and Open file
  location, which is what "I can't pin my fork" turned out to be. Builds →
  Options writes
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Tabby-fork.lnk`; pinning it
  is still a right-click, and the pin that results is a copy this page then
  keeps retargeted.
- **One stable shortcut name, never the build's.** Pinning copies the file, so
  a name that changed with the active build would strand every pin made from
  it. `setActive` retargets it — but only when it already exists: putting an
  app in someone's Start menu because they clicked "make active" is not the
  page's call.
- **Two slots means two shortcuts, and neither is ever retargeted.**
  `Tabby-fork-canary.lnk` and `Tabby-fork-dev.lnk` (in `~\Tabby\` and in the
  Start menu) point at fixed paths, so `make-slot.mjs` writes them once and a
  pin made from either stays correct across every rebuild. The older
  `Tabby-fork.lnk` is kept, aimed at dev, because a Start pin made from it is a
  copy that would otherwise break.
- **On first run the page adopts whatever the pin already points at**, rather
  than nominating a build and overruling the desktop.
- **A source build can be pinned because of `--dev`.** A `.lnk` cannot carry
  environment variables, and dev mode was previously only expressible as
  `TABBY_DEV=1`, so the shortcut would have started an Electron with no
  plugins. `app/lib/index.ts` now sets `TABBY_DEV` when `--dev` is on the
  command line. `--user-data-dir` covers the rest: `TABBY_CONFIG_DIRECTORY`
  defaults to `app.getPath('userData')`, which follows it. Verified by
  launching with the env explicitly scrubbed.
- The icon is rewritten with the target, and for a source build it comes from
  `build/windows/icon.ico` in the checkout — the target there is `electron.exe`,
  whose icon is Electron's.

## The jump list wears the profiles' own icons

Right-clicking Tabby in the taskbar or the Start menu offers your profiles.
Upstream already built that list (`tabby-electron/src/services/dockMenu.service.ts`)
but gave **every entry `iconPath: process.execPath`**, so it was a column of
identical Tabby logos that told you nothing about what you were about to open.
`jumpList.service.ts` builds the list and `jumpListIcons.service.ts` draws each
profile's own icon into a file the shell can read; both are add-only, and the
edit to the upstream file is one call.

A profile icon is a Font Awesome class or an inline SVG document, and
`iconPath` takes neither — it wants a file plus an index. So rasterize them:
the same conclusion the Windows Terminal maintainers reached in
microsoft/terminal#10552, and what the reference fork does with
Direct2D/DirectWrite. Here **the renderer already is a text-and-SVG rasterizer**,
so a canvas does it with no native code and no new dependency.

- **The glyph comes out of the stylesheet, not a table of codepoints.** A probe
  element gets the class and `getComputedStyle(el, '::before').content` answers
  with the character; the family and weight come from the same place. That
  covers solid, regular and brands at once, survives a Font Awesome bump, and
  a class that resolves to no icon font is how an unknown one is detected.
- **`.ico` is written by hand** — nothing in this stack encodes one, and a
  canvas produces PNG and nothing else. The container is a directory plus one
  PNG per size (16/24/32/48, i.e. a 16px shell icon at 100–200%), which has
  been legal since Vista.
- **The blank check is the only honest test.** A font that had not loaded, an
  SVG whose paths fall outside its viewBox and a mistyped class all produce a
  perfectly well-formed file full of nothing. The canvas is scanned for a
  non-transparent pixel before anything is written; failing that, the entry
  falls back to the app icon. **An entry is never dropped and never blank.**
- **The webfont has to be waited for.** `font-display: block` means the CSS
  knows the family long before the file arrives, and a canvas silently
  substitutes rather than waiting — so the first rebuild after a cold start
  drew tofu until `document.fonts.load` was added.
- **Resolve once, draw four times.** Reading the class out of the stylesheet is
  a DOM insertion and a forced style recalc, and parsing an SVG is a whole
  document; neither is per-size. Measured on the renderer thread, 28 profiles:
  a cold pass draws 15 distinct icons in ~1.1s (~0.3s once the webfonts are
  warm), a warm pass draws none and costs nothing. The loop awaits I/O between
  icons, so that is not 1.1s of blocked event loop.
- **Icons live in `<config dir>/jumplist-icons`**, keyed on the icon *and* the
  colour, and pruned to what the last pass handed out. Beside `config.yaml`
  because a slot's app files are read-only and `data\` is the only writable
  part of one — and because two builds running side by side must not hand each
  other a file drawn for the other's theme. `original-fs` throughout: a
  portable build's config directory is a sibling of `resources\app.asar`, and
  one patched `fs` call on an archive pins it for the process's life.
- **The cache is re-checked, not trusted.** The shell's copy of the list
  outlives the app, the build and the profile directory, so a cached path is
  `access`ed every pass and redrawn if it has been swept — which is what
  happens when a slot is deleted.
- **The colour is `SystemUsesLightTheme`, not `AppsUseLightTheme`** and not
  Tabby's own scheme, which the user may have forced the other way. The jump
  list is taskbar chrome. A monochrome glyph baked in the wrong colour is
  invisible against the flyout, which looks exactly like the blank tile this
  set out to fix. A profile's own `color` wins when it has one.
- **An empty custom category makes the shell reject the whole call**, not just
  that category — so on a profile where nothing had been opened yet, upstream's
  list was refused entire and *no* profiles appeared. Empty categories are now
  dropped, and the result string is logged instead of discarded.
- **`profile "<name>"` was interpolated, not quoted.** Profile names are free
  text; one containing a quote produced an entry that opened the wrong profile
  or none. `quoteArgument()` applies the CRT's rules (double the backslashes
  before a quote, escape the quote). Two profiles sharing a name now produce
  one entry, since `profile <name>` resolves by name and the second was
  unreachable however it was listed.
- **Staleness is already handled by `config.changed$`.** `DockMenuService`
  subscribes to it, and `tabby-builds`' "make this the active build" ends in
  `config.save()` — so activating a slot rebuilds the list, which is the
  analogue of the reference fork's refresh-on-deploy. Asserted in the test
  rather than assumed.
- Entries launch `process.execPath` — *this* build, deliberately, not the
  active one. They are built from this instance's profiles, and only this
  build's config directory knows what those names mean.

### What writes whose jump list

A jump list is shell state keyed on the app's AppUserModelID, so this is the
one thing here that is visible to the whole desktop. Measured on this machine
by reading `%APPDATA%\Microsoft\Windows\Recent\CustomDestinations` — the files
are shell links, so the paths inside are greppable as UTF-16:

- **The dev build keeps its own file.** Its entries name
  `…\projects\tabby\node_modules\electron\dist\electron.exe`; the packaged
  builds' name a `Tabby.exe`. So running a dev instance does not overwrite a
  packaged build's list — but that is asserted, not relied on:
  `app/test/jumpList.test.js` hashes every jump list file naming a `Tabby.exe`
  before the run and refuses to pass unless they are byte-identical after.
- **Only one packaged Tabby has a file**, and its entries point at
  `~\Tabby\builds\dev\Tabby.exe` — the slot, not the installed app. Either the
  two share an identity and the slot wrote last, or the installed app's write
  never landed. Not resolved; worth knowing before trusting a jump list to
  belong to the build you think it does.
- **The test publishes exactly once**, and only after giving the instance a
  scratch AppUserModelID of its own, deleting the file that leaves behind.
  Every other check runs against `JumpListService.build()`, which produces the
  categories and the icon files and publishes nothing.
- Dev entries are dead either way: `electron.exe profile "X"` has no app path,
  so it starts nothing. Left alone — it is upstream's shape, and it now lands
  on an identity nothing else uses.

**`b8bc5aa7e` from the reference fork does not apply here** and was skipped
deliberately: it keeps a local copy of profile icons given as http(s) URLs so
settings load does not block on the network. Tabby has no URL profile icons —
`profileIcon.component` renders a Font Awesome class or an inline HTML string
and nothing else, and the settings field is a typeahead over class names.
There is nothing to cache. (Such a string reaches the rasterizer as neither a
glyph nor markup, so it falls back to the app icon rather than misbehaving.)

## A build must load its own plugins

**A Tabby exports `NODE_PATH` to every shell it starts** — its own
`builtin-plugins`, its `app.asar\node_modules`, and `%APPDATA%\tabby\plugins\node_modules`
— and `initModuleLookup()` used to *append* its own paths to whatever it
inherited. So a Tabby started from a terminal inside another Tabby resolved
`tabby-core` to the **other build's** copy: two Angulars, and a boot that stops
dead on the splash screen. This is the dev-build gotcha in *Launching* above,
except it bites a packaged slot exactly as hard, and there it is invisible —
there is no console to see it in.

- **The symptom is an idle process, not a busy one.** Measured on the real
  failure: the renderer sat at 94 MB and 0% CPU for five hours, window titled
  `Tabby`, nothing in the app log after `renderer-start`. `diagnostics.log` had
  the answer in one line — `require-failed`, `tabby-local`, MODULE_NOT_FOUND —
  and a sampled 203 ms `readFileSync` of
  `%APPDATA%\tabby\plugins\node_modules\tabby-core\dist\index.js`, which is a
  path no healthy build should ever read.
- **A stale copy of a builtin in the user plugin directory does the same.**
  Three of them were there, at 1.0.197, pulled in by `tabby-backslash-newline`
  listing `tabby-core`/`tabby-settings`/`tabby-terminal` under `dependencies`
  rather than `peerDependencies`. `findPlugins()` already skips such copies for
  *discovery*; nothing stopped `require` finding them first.
- **The fix is ordering plus absolute paths**: this build's paths go ahead of
  anything inherited, and the four builtins are required from
  `builtinPluginsPath` by absolute path rather than by name. (`+=` on an unset
  `NODE_PATH` also left a literal `"undefined"` entry, for years.)
- **Relaunching does not clear it.** The single-instance lock hands the launch
  to the poisoned process, which opens another window that never boots either —
  which is what "it's still hanging" turned out to mean. That instance has to
  be closed first.
- `app/test/moduleLookup.test.js` resolves the four builtins under each
  poisoned environment and asserts they all come from the build itself. Like
  the asar test, it also asserts the *old* ordering still fails — otherwise a
  green run on a clean machine would prove nothing.

## A useless process must not hold the lock (`app/lib/watchdog.ts`)

The fix above stops one *cause*. The trap it produced was the single-instance
lock: exactly one process answers for the app, so once that process cannot show
a window, every later launch is handed to it and silently swallowed — no
window, no error, no crash, indefinitely. Six hours of it, measured. Nothing
anywhere checked that the lock holder had ever produced a **working** window.

**`app:ready` is the only line that matters.** It is sent from
`appRoot.ngOnInit` once `config.ready$` resolves, so it means an Angular root
exists in that renderer — and everything that can open a tab or spawn a PTY
lives at or after that point. A process in which *no* window has ever emitted
it has never run a session and holds nothing to lose. The first one disarms the
watchdog permanently, for the life of the process. That single rule is what
makes code that can call `app.exit()` safe to ship.

Two failure shapes, and they need different tests:

- **No window at all** — a creation that threw, or a handoff that produced
  nothing. `activate`, the `app:new-window` IPC and `handleSecondInstance` all
  call `newWindow()` with no catch, so the failure vanishes and the process
  carries on with nothing to show. Ported from the reference fork's
  `_armNoWindowWatchdog` (`c353d92a1` in the Windows Terminal fork): five
  seconds, and it returns early whenever a window exists.
- **A window that never booted** — the one that actually bit, and the half a
  zero-window check cannot see. `newWindow()` pushes the window onto its list
  *before* awaiting `window.ready`, so the window exists, the renderer is alive,
  and from outside nothing looks wrong. Armed once at `app-ready`; sixty
  seconds; fires only on "no window has ever reached `app:ready`".

- **The boot budget is spent in ticks of a live event loop, not wall clock.** A
  main process blocked for 19.7s during `main-start` is measured here on every
  cold launch — it has not given the renderer that time, and burning the budget
  on it would quit a build that was only slow. Measured margin: a healthy dev
  build reaches `app:ready` **1.3–3.8s** after the watchdog arms.
- **`app.exit()`, never `app.quit()`.** `Window`'s own `close` handler calls
  `preventDefault()` and asks the renderer to confirm; a renderer that never
  booted never answers, so quitting politely would hang in exactly the place we
  are escaping.
- **It writes to both logs before exiting.** `diagnostics.log` batches behind a
  one-second timer and `app.exit()` runs no timers, so `flushDiagnostics()`
  writes synchronously — otherwise the one record explaining the exit is the one
  record guaranteed to be lost. The reason also goes to
  `main-process-errors.log`, which is where someone asking "why did Tabby quit
  on me?" actually looks.
- A `window-ready` record is now written on every successful boot, with how long
  it took. The boot phase marks are breadcrumbs, which are invisible unless
  something stalls — so this was previously unanswerable from outside.
- `TABBY_WATCHDOG=0` disables it; `TABBY_WATCHDOG_BOOT_MS` and
  `TABBY_WATCHDOG_NO_WINDOW_MS` retune it without a rebuild.

`app/test/watchdog.test.js` launches three real dev builds against throwaway
profiles. **The poisoned `NODE_PATH` no longer reproduces the fault** — the fix
above works, and a dev build launched with the installed app's plugin
directories on `NODE_PATH` now boots in under two seconds. The lever is
blacklisting `core` instead: the same fault class the doctor covers (a builtin
the app cannot start without is unavailable), landing in the same state —
bootstrap fails, safe mode fails behind it, the renderer sits on the splash
screen at 0% CPU and the window is still there. Like the module-lookup test it
also runs the fault with `TABBY_WATCHDOG=0` and asserts it *still* hangs,
because otherwise a fixture that quietly stopped reproducing would turn the
whole run green.

**Two things it cannot cover, both worth knowing:**

- The zero-window half is not reachable end-to-end on Windows. Induce a window
  construction that throws (a `window.json` with non-numeric bounds does it, at
  `window.ts:98`) and `index.ts`'s own handler catches it first —
  `dialog.showErrorBox` is a **blocking** modal, so the main loop stops there
  and no timer of ours can run. That is its own hostage shape: alive, holding
  the lock, zero windows, and on an unattended launch nobody sees the box.
- A wedged *main* process is beyond all of this, by construction. The watchdog
  runs on that loop.

## Where each window was

Position and size are remembered **per window**, in `<config dir>/window.json`
under `windowGeometries`. Upstream keeps one `windowBoundaries` key that every
window reads and writes, which is invisible with one window and wrong the moment
there are two: the second opens exactly on top of the first, and whichever
closes last overwrites the other. Multi-window is fork-added; the persistence is
upstream's and was never scoped to it.

- **The identity is the window ordinal, because it is the only one Tabby already
  has.** `isMainWindow` — the first window in `Application.windows` — is the sole
  condition under which the saved tab list is replayed (`app.service.ts`), so a
  window-scoped thing is already keyed off an ordinal; this widens that from one
  bit to N. Nothing else about a window survives a restart to key off: the tab
  list is one `localStorage` blob shared by every window in the partition, and
  only the main window reads it.
- **Slots are claimed lowest-free and released on close**, so *open* order
  decides them and close order cannot disturb them. Open order at launch is not
  a guess — `app.on('ready')` creates exactly one window — so slot 1 is always
  the main window. What it does not survive: closing window 1 and opening
  another mid-session hands the new one slot 1, so it lands where window 1 was.
- **No DPI is stored.** Windows Terminal's version of this (microsoft/terminal#12633,
  the reference for the port) keeps physical pixels and rescales them; Electron's
  screen coordinates are already per-display DIPs, so rescaling would introduce
  exactly the drift it exists to prevent.
- **A frameless window reports back 2px taller than the size its constructor was
  given.** Measured, consistently. `getBounds()` is what gets saved, so a window
  only ever opened and closed grew 2px and crept down the screen every launch —
  upstream has this too. `setBounds` is exact, so the restored rectangle is
  applied once more after construction.
- **"On screen" is decided by the title bar, not by area.** The old check only
  fired when the saved rect missed the nearest display *entirely*, so a window
  whose title bar was above the top of the screen was restored exactly there and
  could not be dragged back. A rect now needs 120px of width and a 32px strip of
  its top edge inside some work area, or it is clamped into the nearest one — and
  a window deliberately hung off an edge is left alone. Size is clamped to the
  work area either way, so a rect saved on a 4K display does not reopen larger
  than a laptop panel. (The old centring was also wrong on a secondary monitor:
  it used the display's *size* without its origin.)
- **A slot with nothing saved cascades** 28px off the newest live window,
  wrapping at the work area edge, rather than opening on top of it.
- Geometry is written on close and 2s after the last move or resize — the
  watchdog's `app.exit()`, a session ending and a crash all skip `close`. The
  write is `conf`'s read-modify-write through `write-file-atomic`, which throws
  rather than losing data quietly, and a failure is recorded as
  `window-geometry-save-failed` (the read-only `data\` of a mis-frozen slot is
  what produces it).
- Slot 1 is mirrored back to `windowBoundaries`, so a build without slots —
  upstream, or an older one of ours — still finds the main window's place.
- Every placement writes a `window-geometry` record to `diagnostics.log`, and an
  adjusted one writes `window-geometry-adjusted` saying what was wrong. "Why did
  my window open there" is otherwise unanswerable from outside the process.

**No setting.** The reference gates this behind `rememberWindowGeometry` because
there it is new behaviour; here geometry has always been remembered and this only
fixes who it belongs to, so a toggle would be a way to ask for the bug. It would
also mean a `configDefaults.yaml` line, and every changed default is a rebase
conflict.

`app/test/windowGeometry.test.js` launches three hidden dev instances and drives
them over CDP, opening the extra windows through `app:new-window`'s own `hidden`
option so a run never shows a window or takes focus. It transcribes the old
placement and runs it against the same `window.json` and the same displays,
because a check only the new code can fail proves nothing — the transcription
puts both windows in one place and accepts the unreachable rect unchanged.

**Probe the debugging port, never assume it.** A port Chromium cannot bind is not
an error it reports: it simply does not listen, and every request goes to whatever
*is* there. Measured — 9251 was the user's own Chrome, full of logged-in tabs, and
the first version of this test was one URL filter away from evaluating JavaScript
in it. It now finds a free port and checks `/json/version` says Electron before
attaching.

## Why it froze (`diagnostics.log`)

`app/lib/diagnostics.ts` records what blocks an event loop, in both the main
process and every renderer, to `<config dir>/diagnostics.log` as JSONL. A frozen
window otherwise leaves no trace: Windows calls the process responding, nothing
throws, and until now the app log had no timestamps to line anything up against.

A stall record reads like this, and the summary alone is usually the answer:

```
renderer event loop blocked 71.3s during "ready" — 98% synchronous I/O:
fs.readFileSync ×58214 (41.0s), fs.unlinkSync ×58214 (28.2s)
```

- **The tally is the point, not a slow-call threshold.** What freezes this app is
  tens of thousands of individually-fast synchronous calls — draining a spool
  directory, walking a build tree — where no single call would ever trip a "slow
  call" limit but the sum blocks the UI for minutes. Every sync `fs` and
  `child_process` method is wrapped and counted; stacks are sampled every 500
  calls and deduplicated, so a burst is attributed without paying for a capture
  on each one.
- **`syncMs` versus `ms` decides where to look.** A stall that is mostly
  synchronous I/O names its own fix; one with almost none is script or GC, and no
  amount of I/O detail would have helped.
- **It installs before zone.js and the plugin loader.** The detector runs on
  timers captured before zone.js patches them — a zone-patched interval would
  schedule a change-detection pass every tick, and would stop reporting at
  exactly the moment the zone is what is wedged.
- **The `fs` wrapper must go on the module `require` returns.** `import * as fs`
  compiles to `__importStar(require('fs'))`, whose properties are forwarding
  *getters*; assigning a wrapper onto that copy throws straight into our own
  `catch` and instruments nobody, with reports still arriving and attribution
  always empty. Verified by checking the bundle: `fs` is emitted as
  `external "fs"` → `module.exports = require("fs")`, the one shared builtin, so
  this covers plugin code too without their cooperation.
- **Records are size-capped by dropping whole fields, never by cutting the
  string** — a JSONL log whose long lines do not parse is worse than one that
  admits it left something out. Lines stay ~1 KB, inside the size where an
  O_APPEND write from several processes still lands atomically.
- Writes are buffered and asynchronous: an instrumentation that blocks the loop
  to report that the loop was blocked would be measuring itself.
- `TABBY_DIAG=0` disables it; `TABBY_DIAG_STALL_MS` (default 250) and
  `TABBY_DIAG_INSTRUMENT_IO=0` tune it without a rebuild. Overhead is two
  `performance.now()` calls and a map lookup per synchronous call, ~200ns.

Also recorded: `render-process-gone`, `child-process-gone`, per-window
`unresponsive` with how long it lasted, renderer `unhandledrejection`, main
`uncaughtException`, and boot phase marks (`app-ready`, `window-created`,
`loading-plugins`, `bootstrapping-angular`, `ready`) so a stall says what was in
progress when it hit.

**And `require-failed` — every module that would not load, including the ones
nothing reports.** `tabby-electron` alone has seven
`try { var wnr = require(…) } catch { }` blocks, and the plugin loader has its
own; before this, a module that failed to resolve left no trace and surfaced
later as something unrecognisable (the documented case: a missing
`windows-process-tree` presenting as `Cannot read properties of undefined
(reading 'getRegistryKey')`).

- **`Module._load` is wrapped, so the throw is seen before any of those catches
  swallow it.** Nothing changes at the seven call sites, third-party plugin code
  is covered without its cooperation, and the error is always rethrown — this
  observes, it does not alter what happens next.
- Deduped by `request|code` and capped at 32 distinct, because a failing
  `require` is often *intentional*: optional dependencies and platform probes
  fail by design. One line per distinct thing that could not load, not one per
  attempt.
- Records the requesting file, so the answer is "which package asked", and the
  boot phase, so a load failure lines up against the stall it caused.
- Verified by reproducing the swallowed shape in a live renderer. It also
  immediately named a real one nothing had ever reported:
  `macos-native-processlist`, MODULE_NOT_FOUND, from `tabby-electron/dist/index.js`
  during `loading-plugins` — harmless on Windows, and previously invisible.
- **`module` must stay in the renderer webpack `externals`** (it is, beside `fs`),
  or `require('module')` resolves to a webpack shim, the wrapper never installs,
  and the whole thing silently does nothing.

**Known offenders it has already named**, both worth fixing at the source:

- `tabby-claude-status`'s `processSpoolDir()` drains `%TEMP%\tabby-claude-status.d`
  with synchronous `readdirSync`/`readFileSync`/`unlinkSync`, uncapped and without
  yielding, on the renderer thread. `hook.js` writes one file per Claude event and
  never prunes, so the backlog is proportional to how long Tabby was *not* running —
  measured 0.126 ms/file warm, and a 3.5-day gap is ~60,000 files.
- A cold main process blocked **17.4s** during `main-start` on `fs.readFileSync
  ×817`, i.e. module loading. Expected to be cheaper from an asar slot than a dev
  build, but it has never been measured before.

## When it isn't the event loop (`tabby-render-timing`)

The stall recorder covers the loop. It says nothing about the other way a
terminal feels slow: nothing blocks, the loop stays free, and the screen still
lags — because frames are being dropped, or because xterm is taking a long time
to parse and lay out what was written to it. `tabby-render-timing` is a builtin
that times both and writes `render-timing` records into the same log:

```
render-timing  frames: 327, slowFrames 3, jankFrames 2, worst 150ms, p50 8.3, p95 8.5
               term1: 7 writes, mean 22.7ms, worst 81ms, 2 slow
```

- **A `TerminalDecorator`, not an edit to `xtermFrontend.ts`.** Add-only, so it
  costs nothing at the next rebase, and it reaches any frontend exposing an
  `xterm` without knowing which. It wraps `xterm.write` and measures call →
  callback, which is the interval that matters: the caller's `await` returns long
  before the screen reflects anything.
- **Tallied, never streamed.** A busy terminal writes thousands of times a
  second; the finding is a distribution. Same principle as the stall recorder.
- **The rAF loop only runs while something is writing** and stops two seconds
  after. A permanent one would keep the compositor awake on an idle window —
  a poor trade for a diagnostic.
- **Gaps over 500 ms are not counted as dropped frames.** An idle tab produces
  one enormous gap, and counting it would make every summary look catastrophic.
- **`note()` was the wrong API and cost a debugging round.** It only appends a
  breadcrumb, which is shown as *context when a stall is reported* and is
  invisible otherwise — so the summaries went nowhere. `report()` was added
  alongside it for records that are the finding rather than context for one.
- Reports only when there is something to say: a healthy hour writes no lines.

## What upstream has that we don't (`tabby-upstream`)

Settings → **Upstream** compares this checkout against the project the fork
tracks: how many commits have landed there that are not here, the patch series
carried on top, and where each commit is on the web. It is the "should I sync?"
question, answered without leaving the app.

- **It never fetches on its own.** Network I/O when a settings page opens is how
  a page earns a reputation for being slow; fetching is a button. Which makes
  the *staleness* the thing that has to be visible, so the last-fetch time is
  shown, warned about past a week, and the page says outright that it is
  reporting what was last fetched rather than what upstream has now. "0 behind"
  from a month-old fetch looks identical to a fresh one otherwise.
- **`FETCH_HEAD`'s mtime is when the fetch happened**; the ref's own mtime is
  when it last *moved*, which is a different question and usually much older.
- **Only a source build has a checkout to find**, by walking up from
  `process.execPath` — a packaged build genuinely has none, since
  `app/dist/build-info.json` records the commit but not where it was built. That
  case is reported plainly, with a setting to point at a checkout anyway, rather
  than guessed at.
- Fields are split on `%x1f`/`%x1e` rather than a delimiter that could appear in
  a commit message.
- A missing `upstream` remote is the ordinary case for a fresh clone, so it is a
  message with the command to fix it, not an error.
- Verified against `git rev-list` on this checkout: behind and ahead counts,
  branch, the newest local subject, and the resolved GitHub URL all match, and
  the Fetch button moves `FETCH_HEAD` in ~1.5s.

## The renderer and xterm 6

The terminal renders through **WebGL**, on **xterm.js 6.0**. Two things worth
knowing before touching either.

**The canvas renderer is gone.** `terminal.frontend: xterm` used to mean
`@xterm/addon-canvas`; that addon was last released in April 2024 against
`@xterm/xterm ^5.0.0` and xterm 6 deletes it outright (xtermjs/xterm.js#5105).
It is also the renderer behind every stale-glyph report upstream has open
(#11511, #9429, #9263, #10378): it repaints only the rows it believes are
dirty, so anything it draws and then loses track of stays on screen until
something forces a full repaint. `XTermFrontend` now means xterm's own DOM
renderer — slow but always correct, and the fallback for the SwiftShader
workaround (#8884) and for a pane whose WebGL context could not be recovered.

**A saved `frontend: xterm` is aliased to WebGL** in
`baseTerminalTab.component.ts` rather than migrated. A fork-owned bump of
`config.version` would make upstream's own migration 9 skip these configs at
the next sync, so the alias is one map entry and no versioning risk.

Four things break in `xtermFrontend.ts` against 6.0, each checked against the
shipped sources rather than the changelog:

- `overviewRulerWidth` is now `overviewRuler: { width, showTopBorder,
  showBottomBorder }`.
- **`_core.viewport._refresh()` is gone.** The viewport is private (`_viewport`)
  and rebuilt on VS Code's scrollable element; `queueSync()` replaces it. The
  synchronous `_renderService._renderRows()` after a fit stays — it is what
  closes the blank frame during a window drag, and `xterm.refresh()` cannot
  replace it because that goes through the render debouncer and lands a frame
  later.
- **`_core.browser` cannot be assigned into.** It is xterm's `common/Platform`
  module namespace, whose properties are read-only getters, so the three
  platform assignments in `configure()` throw. Spread it instead. This only
  bites on 6.0 because the ESM build hands out a real namespace object where
  the CommonJS one handed out a plain object.
- **`scrollToBottom()` gained `disableSmoothScroll`** and xterm's own callers
  pass `true`. Without it every pinned write starts a scroll animation. Same for
  restoring a scroll position while unpinned, which is why that now goes through
  the viewport directly.

xterm 6 also **paints `.xterm-viewport` black and `.xterm-scrollable-element`
white**, both on top of Tabby's background — measured, not theorised. Both are
overridden in `xterm.css`. The scrollbar slider needs nothing from us: xterm
derives it from the theme's foreground at 20/40/50% opacity, which already
follows a light or dark scheme.

### The addon that cannot be bundled

**`@xterm/addon-unicode-graphemes@0.4.0` hangs the renderer if it is imported
into `tabby-terminal` at all.** This is what forced the previous attempt at the
xterm 6 upgrade to be reverted (`9c4266f0` / `c9fcd052`), and it is why the
emoji-width fix is still open.

The symptom: the renderer spins at 100% CPU during module evaluation — before
a single plugin loads, because `initModuleLookup()` eagerly requires
`tabby-terminal` before `findPlugins()` runs — so the app log stops after
`Window bootstrap data` and the window sits on the splash screen for ever.
Measured at 270s of CPU and climbing.

- **V8's inspector cannot interrupt it.** `Debugger.enable` gets no reply and
  no `scriptParsed` events arrive, so `Debugger.pause` never lands. That rules
  out the usual approach and is itself a clue: a plain JS loop is interruptible.
- **It is the import, not the use.** Replacing `loadAddon(new
  UnicodeGraphemesAddon())` with `void UnicodeGraphemesAddon` still hangs.
  Removing the import entirely boots in seconds.
- **Not the ESM entry.** Every `@xterm` package at 6.x ships both a CommonJS
  `main` and an ESM `module`, and the shared config's `mainFields` prefer
  `module`, so the upgrade does silently move the whole tree onto `.mjs` — but
  forcing `mainFields: ['main', ...]` (confirmed with
  `scripts/dev/which-modules.mjs`) hangs identically. Note `resolve.alias` is
  useless here: `@ngtools/webpack`'s resolver ignores it.
- **Not babel.** `babel-loader` runs over every `.js` in node_modules; excluding
  the `@xterm` packages from it hangs identically.
- **Not the addon itself.** Loaded standalone it takes 11-15 ms, from either the
  `.js` or the `.mjs` build.

So it is something about that module inside this bundle, and it is still
unexplained. The earlier investigation cleared the addon by loading it
standalone, which is exactly the test that does not reproduce it.

### Measuring stale glyphs

`tabby-terminal/test/glyphs.cdp.js` answers "did the renderer leave anything on
screen the buffer does not account for" with a number, over CDP against a
hidden dev build (`scripts/dev/launch-hidden.mjs`). It fills the scrollback
past capacity, scrolls up with real wheel events while output keeps arriving,
resizes mid-flow, snapshots the renderer's own canvases, forces the full
repaint a tab switch would do, and snapshots again. Any pixel that moved was
stale; the buffer is serialized on both sides so a run that changed content is
discarded.

**It reports 0 dirty cells on canvas, on WebGL and on xterm 6** — so it does
not reproduce the artifacts that prompted this work and cannot be cited as
proof they are fixed. Its instrumented `refreshRows` counter says why: under
this generator a full-viewport repaint follows nearly every buffer scroll, so
nothing can go stale. Whatever the real conditions are, they are narrower than
this.

Reading the canvases directly rather than screenshotting is deliberate: the
result then does not depend on the window being composited, which is what makes
it usable on a `--hidden` instance.

## Searching the selection (`tabby-terminal/src/webSearch.ts`)

Right-clicking a selection offers **Search the web for "…"**, which opens
`terminal.webSearchQueryURL` — `https://www.google.com/search?q={{query}}` by
default — through `platform.openExternal()`. Upstream has no web-search action
anywhere; Windows Terminal's `searchWeb` is the model, and its Bing default
wrapped the selection in `%22…%22`, which this deliberately does not: the
selection searches as ordinary terms.

- **`{{query}}`, not Windows Terminal's `%s`.** `{{name}}` is already how every
  URL built from matched text is written here — the `tabby-links` integration
  manifests use `{{match}}` and friends — so there is one templating convention
  in the repo rather than two.
- **The template is parsed twice and the origins compared.** The selection is
  text a remote host printed; `encodeURIComponent` alone already stops it
  becoming a second parameter or a fragment, but a template is also probed with
  an inert stand-in and the result refused unless the scheme is http(s) and the
  final URL's origin is identical to the probe's. So a template can never be
  turned into a different host by what was selected, and a malformed or
  `javascript:`/`file:` template opens nothing and says why instead.
- **`&` in a menu label is a mnemonic on Windows and Linux**, so a selection of
  `foo & bar` would show as `foo _bar`. It is doubled for those platforms and
  left alone on macOS, where Electron takes labels verbatim. Truncation happens
  *before* the doubling, or a cut could split a `&&`.
- **ICU MessageFormat passes `{{query}}` through as an argument.** The "must be
  an http(s) URL containing {{query}}" notification would be a compile error if
  the braces were in the pattern, so the token rides in as `{token}`;
  `webSearch.cdp.js` asserts the rendered string.
- Selections are capped at 512 characters and whitespace runs collapse to single
  spaces — a terminal selection can be megabytes, and a multi-line one has to
  search, and label, as one line.

## Changed upstream defaults

Kept to a minimum — every one is a line that conflicts on rebase.

- `appearance.tabsLocation: left` (`tabby-core/src/configDefaults.yaml`) —
  vertical tabs. Titles here are paths and session names, which a horizontal
  strip truncates to nothing. Only affects profiles with no value saved.

- `terminal.minimumContrastRatio: 1` (`tabby-terminal/src/config.ts`), was `4`.
  The value goes straight into `xterm.options.minimumContrastRatio`, and
  xterm.js rewrites **every** foreground that misses the ratio — 24-bit ones
  included (`TextureAtlas._getMinimumContrastColor` has no `CM_RGB` exemption).
  At 4, and worse at 6, that recolours entire palettes: Solarized Light on a
  light background sits at 3–5:1, so all 13 of its colours get pushed toward
  mud and near-neighbours collapse onto each other. 1 is the "off" value and
  what xterm.js itself defaults to; Windows Terminal's equivalent,
  `adjustIndistinguishableColors`, resolves `Automatic` → `Never` unless
  Windows high-contrast is on (`TerminalCore/Terminal.cpp`). So this is now
  "draw what the app asked for", same as WT/iTerm2.

  **The same key also drove the app chrome's contrast floor**
  (`ThemesService.applyThemeVariables` contrast pairs), so dropping the default
  would have dimmed derived UI colours like `--theme-fg-less-2` that are faint
  by design. Chrome now floors at its own `UI_MINIMUM_CONTRAST_RATIO = 4`
  (the old default) via `max(4, terminal.minimumContrastRatio)` — measured
  identical output at 1 and at 4, while 6 still escalates it, so raising the
  setting for accessibility keeps working.

## The accent colour

`appearance.accentColor` (Settings → **Window**) colours every `<code>` in the
app — paths, commits, identifiers, the build tooltip. Null follows the colour
scheme.

- **What it replaces is Bootstrap's `$code-color`, a pink (`#d63384`) belonging
  to no scheme here.** `theme.vars.scss` overrode it to orange, but nothing
  imports that file any more — `theme.new.scss` imports Bootstrap with its own
  defaults — so the pink was live and was the only hardcoded accent left in the
  UI.
- **The configured value is parsed before it is used.** `applyThemeVariables`
  runs on every keystroke in the settings box, and a half-typed `#ab` thrown out
  of `Color()` would take every other variable in that pass with it.
- It goes through the same contrast floor as the rest of the chrome, so a pale
  pick is darkened against the window background rather than left illegible.
- The build tooltip now follows the theme (`--bs-tooltip-bg`) instead of being
  Bootstrap's near-black, which is what keeps the accent inside it legible —
  it is contrasted against the window, not against black.

## The splash screen

Follows the OS scheme now. The window's backing colour already did
(`opaqueBackgroundColor()` reads `nativeTheme.shouldUseDarkColors`); only the CSS
was hardcoded dark, so a light desktop got a black flash before the window drew.

`app/src/preload.scss` keeps its dark values as-is and adds a
`@media (prefers-color-scheme: light)` block that overrides four of them — an
override rather than a pair of themes, so the dark path's diff is nil and the
rebase surface on an upstream file stays one appended block.

- **`prefers-color-scheme` is already correct when the splash paints.**
  `setDarkMode()` runs during window construction (`window.ts:141`), before the
  page is shown, so the media query reflects `appearance.colorSchemeMode` — the
  user's choice, not merely the OS default.
- The light background is `#f5f7f9`, deliberately not white: the logo's palest
  gradient stops (`#ccecff`, `#9feced`) all but vanish against pure white.
- Verified by extracting the compiled stylesheet out of `app/dist/preload.js` and
  rendering the real splash markup under both `nativeTheme.themeSource` values in
  an off-screen window — dark stays exactly `#1d272d`/`#a1c5e4`, light comes back
  `#f5f7f9`/`#2f5d80`.

## Known issues to fix in this fork

- **Emoji width** — `❇️` gets **one** column where Windows Terminal gives two, so
  the glyph paints wider than the cell reserved for it and everything after it sits
  one column off. xterm 6 removed the first blocker; the addon that carries the fix
  is now the blocker. See Planned, and *The addon that cannot be bundled* above.
- **The stale-glyph artifacts that prompted the renderer work are not reproduced**
  by `tabby-terminal/test/glyphs.cdp.js`. Retiring the canvas renderer is
  well-founded on its own, but it is not *measured* to be the fix.
- Open upstream PR by us, not yet merged — carry it here rather than waiting:
  [#11383](https://github.com/Eugeny/tabby/pull/11383) fix(linkifier): keep `:` `,` `/`
  in clickable URL path/query.

## Planned

- **Emoji width.** xterm 6 has landed (see *The renderer and xterm 6* above), which
  was the prerequisite — but the addon that carries the fix cannot be loaded.

  | sequence | xterm + unicode11 | other terminals |
  |---|---|---|
  | `U+2747` alone | 1 | 1 |
  | `U+2747 U+FE0F` (`❇️`) | 1 + 0 = **1** | **2** |
  | `U+2705` (emoji by default) | 2 | 2 |

  VS16 is width 0 and never promotes its base to the emoji-presentation width 2.
  `@xterm/addon-unicode11` cannot fix that at any version, and on xterm 5.4
  swapping in `@xterm/addon-unicode-graphemes` did nothing either: 5.4's
  `UnicodeService` delegates only `wcwidth` to the provider and implements
  `charProperties` itself on top of it, so the provider's richer version was never
  called. xterm 6 does delegate `charProperties`, so the swap would now work.

  **What blocks it is that `@xterm/addon-unicode-graphemes@0.4.0` cannot be put
  in this bundle at all** — see the hang described above. Until that is
  understood, `unicode11` stays and `❇️` keeps its stray space.

- **`useConptyDll`.** node-pty 1.2.0-beta.8 bundles conpty 1.23 under
  `third_party/conpty/`, but `tabby-local/src/session.ts` never passes
  `useConptyDll`, so sessions run on whatever conpty ships with Windows. xterm 6's
  reflow work is aligned to conpty >= 1.22 (xtermjs/xterm.js#5321), and VS Code
  turned the equivalent setting on to fix resize corruption. Worth measuring.
