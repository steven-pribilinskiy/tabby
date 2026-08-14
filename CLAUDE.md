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

## Changed upstream defaults

Kept to a minimum — every one is a line that conflicts on rebase.

- `appearance.tabsLocation: left` (`tabby-core/src/configDefaults.yaml`) —
  vertical tabs. Titles here are paths and session names, which a horizontal
  strip truncates to nothing. Only affects profiles with no value saved.

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
- **Crash and slowdown instrumentation.** Find the gaps: `render-process-gone`,
  `child-process-gone`, `unresponsive`, main-process `uncaughtException`, renderer
  `unhandledrejection`, and plugin-load failures (several are swallowed by bare
  `catch {}` — see the `wnr` case above). Add timing around boot phases and frame/write
  latency so slowdowns show up in logs rather than as a feeling.

- A **Settings page listing upstream commits this fork lacks** — compares
  `local` against `upstream/master` and shows what has not been pulled in.
- **Splash screen should follow the system theme.** It is hardcoded dark today:
  `app/src/preload.scss` (`app-root { background: #1D272D }`, `.preload-logo`
  radial-gradient to black, `.tabby-title` `#a1c5e4`) and `app/lib/window.ts:205`
  (`setBackgroundColor('#131d27')`). Nothing consults `prefers-color-scheme` or
  Electron's `nativeTheme`, though `window.ts:215` already sets `nativeTheme.themeSource`
  from config — so the config value exists to key off.
