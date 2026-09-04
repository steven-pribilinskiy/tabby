# tabby-links tests

Three kinds, because three different things need proving.

## `logic.test.js` — pure logic, no app

```bash
node tabby-links/test/logic.test.js
```

Loads the package's own TypeScript sources through a `.ts` require hook and exercises the
exported helpers directly: JSON pointers, template expansion, host guarding, the regex guard,
badge colours, secret masking, the `html` document builder, and manifest compatibility with the
Windows Terminal fork. Needs nothing running.

Run this first. It is fast, and most regressions show up here.

## `*.cdp.js` — the real UI, over CDP

Launch the dev build **hidden**, so nothing takes focus:

```bash
P=<some scratch dir>/tabby-profile
NODE_PATH='<repo>/app/node_modules' TABBY_PLUGINS= TABBY_DEV=1 TABBY_CONFIG_DIRECTORY="$P" \
  ./node_modules/electron/dist/electron.exe \
  --user-data-dir="$P" --remote-debugging-port=9238 app --hidden
```

`--user-data-dir` must come **before** `app`, or Electron hands the switch to the app and
silently ignores it — the dev build then shares `%APPDATA%\tabby` with the installed Tabby.

```bash
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/links.cdp.js        # discovery, rules, settings pages
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/card.cdp.js         # hover card placement and buttons
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/preview.cdp.js      # the fetch pipeline against live stith
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/credentials.cdp.js  # safeStorage, and what reaches config.yaml
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/html.cdp.js         # the sandboxed html frame
```

Pass `TABBY_CONFIG_DIRECTORY` so the suites can read the profile they are driving. `html.cdp.js`
is where the sandbox is asserted — **that the frame's `sandbox` is exactly `allow-scripts` and
that `allow-same-origin` is absent is the single most important assertion in this package.**

These run against a *reused* profile that may hold real settings someone typed. Write them to
establish whatever state they assert on and put it back afterwards; do not assume a clean one.

## `htmlPage.electron.js` — a manifest page measuring itself

```bash
./node_modules/electron/dist/electron.exe tabby-links/test/htmlPage.electron.js
# DIAG=1 for what the page saw
```

This one cannot be folded into `html.cdp.js`. Chromium throttles rendering for a cross-origin
subframe that is never visible, so in the hidden dev build the sandboxed frame's document is
never laid out and every measurement inside it reads `0` — including a `height: 77px` div. The
page therefore gets its own window, shown **without focus** and positioned off-screen, purely so
a compositor runs.

## Never

Kill the installed Tabby. The dev build is `electron.exe`; the installed app is `Tabby.exe`, it
holds live sessions, and it is off-limits. Stop the dev build **by PID**, never by name, and
check `(Get-Process Tabby).Count` is unchanged afterwards.
