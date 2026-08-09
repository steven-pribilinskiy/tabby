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

## Known issues to fix in this fork

- **Emoji width**: `❇️ ` (and other VS16 emoji) render one column too wide, leaving a
  stray space that Windows Terminal does not produce. xterm.js width handling.
- Open upstream PR by us, not yet merged — carry it here rather than waiting:
  [#11383](https://github.com/Eugeny/tabby/pull/11383) fix(linkifier): keep `:` `,` `/`
  in clickable URL path/query.

## Planned

- A **Settings page listing upstream commits this fork lacks** — compares
  `local` against `upstream/master` and shows what has not been pulled in.
- **Splash screen should follow the system theme.** It is hardcoded dark today:
  `app/src/preload.scss` (`app-root { background: #1D272D }`, `.preload-logo`
  radial-gradient to black, `.tabby-title` `#a1c5e4`) and `app/lib/window.ts:205`
  (`setBackgroundColor('#131d27')`). Nothing consults `prefers-color-scheme` or
  Electron's `nativeTheme`, though `window.ts:215` already sets `nativeTheme.themeSource`
  from config — so the config value exists to key off.
