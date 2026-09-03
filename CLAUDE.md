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
- **The card is `position: fixed` but a DOM child of `.xterm-screen`.** It has to
  be a descendant or xterm's `xterm-hover` guard never applies and `mouseleave`
  clears the link the instant the pointer reaches the card; it has to be fixed or
  `.content { overflow: hidden }` clips it near a pane edge. The fixed containing
  block is not always the window (`app-root` has `will-change: transform`, a
  maximized split has `backdrop-filter`), so it is placed by measuring its own
  origin at `translate(0,0)` and then translating.
- **Everything runs outside `NgZone`** — xterm's listeners are raw DOM. The card
  is created with `createComponent` + `ApplicationRef.attachView` (no
  `ViewContainerRef` exists in a decorator) and updated inside `zone.run`.
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

`node scripts/make-slot.mjs [--activate] [--dry-run] [--skip-build]` builds a
frozen, self-contained copy into `~\Tabby\builds\` and, with `--activate`,
points `Tabby-fork.lnk` and the taskbar pin at it.

- Named **`<version>-<MMDD>-<HHmm>-<sha>`**. The timestamp comes before the hash
  deliberately: a Start-menu search result truncates the *tail*, so a trailing
  date was the part you could never read, and the hash alone told you nothing
  about which slot was newer.
- `--dir` only — a slot is an unpacked directory, never an installer.
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

**Known offenders it has already named**, both worth fixing at the source:

- `tabby-claude-status`'s `processSpoolDir()` drains `%TEMP%\tabby-claude-status.d`
  with synchronous `readdirSync`/`readFileSync`/`unlinkSync`, uncapped and without
  yielding, on the renderer thread. `hook.js` writes one file per Claude event and
  never prunes, so the backlog is proportional to how long Tabby was *not* running —
  measured 0.126 ms/file warm, and a 3.5-day gap is ~60,000 files.
- A cold main process blocked **17.4s** during `main-start` on `fs.readFileSync
  ×817`, i.e. module loading. Expected to be cheaper from an asar slot than a dev
  build, but it has never been measured before.

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

## Known issues to fix in this fork

- **Emoji width**: `❇️ ` (and other VS16 emoji) render one column too wide, leaving a
  stray space that Windows Terminal does not produce. xterm.js width handling.
- Open upstream PR by us, not yet merged — carry it here rather than waiting:
  [#11383](https://github.com/Eugeny/tabby/pull/11383) fix(linkifier): keep `:` `,` `/`
  in clickable URL path/query.

## Planned

- **Emoji width.** `❇️ ` (U+2747 + VS16) renders one column narrower than Windows Terminal,
  leaving a stray space. `xtermFrontend.ts:145-146` already loads `Unicode11Addon` with
  `unicode.activeVersion = '11'` — but the Unicode 11 addon computes width per codepoint
  and ignores variation selectors, so VS16 (width 0) never promotes U+2747 from width 1
  to the emoji-presentation width 2 that other terminals use. Fix is
  `@xterm/addon-unicode-graphemes` (grapheme clustering + VS16), which needs `@xterm/xterm`
  moved off the pinned 5.4.0 — a renderer-wide upgrade, so do it deliberately and
  regression-test the terminal.
- **Frame and write latency.** The stall recorder (below) covers the event loop; it
  says nothing about a terminal that renders slowly while the loop stays free. Time
  the xterm write path and frame callbacks so that shows up too.
- **Plugin-load failures** are still swallowed by bare `catch {}` in several places
  (see the `wnr` case above). The renderer `error` handler catches what reaches the
  top; the silent ones need the catches instrumented individually.

- A **Settings page listing upstream commits this fork lacks** — compares
  `local` against `upstream/master` and shows what has not been pulled in.
- **Splash screen should follow the system theme.** It is hardcoded dark today:
  `app/src/preload.scss` (`app-root { background: #1D272D }`, `.preload-logo`
  radial-gradient to black, `.tabby-title` `#a1c5e4`) and `app/lib/window.ts:205`
  (`setBackgroundColor('#131d27')`). Nothing consults `prefers-color-scheme` or
  Electron's `nativeTheme`, though `window.ts:215` already sets `nativeTheme.themeSource`
  from config — so the config value exists to key off.
