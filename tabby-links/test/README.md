# tabby-links tests

Three kinds, because three different things need proving.

## `logic.test.js` — pure logic, no app

```bash
node tabby-links/test/logic.test.js
```

Loads the package's own TypeScript sources through a `.ts` require hook and exercises the
exported helpers directly: JSON pointers, template expansion, host guarding, the regex guard,
badge colours, secret masking, the `html` document builder, the rule presets, and manifest
compatibility with the Windows Terminal fork. Needs nothing running.

The preset section is the one that *measures*: every shipped preset is timed through
`checkPattern` and then run against adversarial input at 512 and 4096 characters, because a
preset the ReDoS guard would refuse is a rule that silently never fires.

Run this first. It is fast, and most regressions show up here.

## `wslPath.test.js` — the resolution order, on a real filesystem

```bash
node tabby-links/test/wslPath.test.js
WSL_DISTRO=Debian WSL_PATH=/etc node tabby-links/test/wslPath.test.js
```

Also plain node, but this one reads the machine, because the bug it covers was
not a translation but an ordering: existence was asked of the path *as written*
— `fs.access('/home/you/notes.md')`, which Windows answers about
`C:\home\you\notes.md` — and that answer gated the translation that would have
made the path real. So it measures both, reimplementing the old ordering beside
the new one, and asserts that upstream's `BaseFileHandler.verify` is still the
bare `fs.access` that comparison assumes. Skips with a message where there is no
WSL. Nothing is started: the distro share is only read.

## `delimitedLinks.test.js` — the `<uri|label>` pattern, and its ReDoS budget

```bash
node tabby-links/test/delimitedLinks.test.js
```

Plain node again. Which spans match, what URI comes out of one, and the premise
the whole feature rests on: that the construct *strictly encloses* the bare-URI
match nested inside it, which is what makes "prefer the delimited match" a
well-defined thing to do with a priority. The pattern runs on a mousemove
handler against text a remote host printed, so it is also timed on adversarial
input — and its growth measured, not just its absolute cost, because an
exponential pattern is cheap at 1000 characters and ruinous at 8000.

## `*.cdp.js` — the real UI, over CDP

Launch the dev build **hidden**, so nothing takes focus. The launcher picks a free debugging
port, writes it down, and the tests find it there:

```bash
node scripts/dev/launch-hidden.mjs --enable links,linkifier   # prints its port and profile
```

```bash
P=<the profile it printed>
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/links.cdp.js        # discovery, rules, settings pages
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/card.cdp.js         # hover card placement and buttons
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/preview.cdp.js      # the fetch pipeline against live stith
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/credentials.cdp.js  # safeStorage, and what reaches config.yaml
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/html.cdp.js         # the sandboxed html frame
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/wslPath.cdp.js      # WSL paths: service, card, click
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/delimitedLinks.cdp.js  # <uri|label>, column by column
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/presets.cdp.js      # both preset entry points
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/clicks.cdp.js       # click chords, end to end
TABBY_CONFIG_DIRECTORY="$P" node tabby-links/test/pane.cdp.js         # Show in pane, and what it must not break
```

With more than one instance up, say which: `CDP_PORT=9247 node …`.

**Never hardcode a debugging port.** Chromium does not report a `--remote-debugging-port` it
could not bind — it just does not listen, and every request then goes to whatever *is* there.
A test that assumed 9238 attached to the user's own Chrome, full of logged-in tabs, and only
a URL filter stopped it evaluating script in them. So `scripts/dev/cdp.cjs` finds the running
instance rather than assuming one, and attaches to nothing until `/json/version` has answered
with JSON that names Electron; `scripts/dev/cdp.test.cjs` asserts the refusals. `CDP_PORT`
names a port, it does not vouch for one — the check runs either way.

A `.cdp.js` that reports by setting `process.exitCode` rather than calling `process.exit()`
must end `main().catch(…).finally(closeAll)`. An open CDP socket holds the event loop, so
without it **every** failure leaves the process alive for ever, which is what
`integrationsFreeze.cdp.js` did.

Launching by hand still works — `--user-data-dir` must come **before** `app`, or Electron hands
the switch to the app and silently ignores it, and the dev build then shares `%APPDATA%\tabby`
with the installed Tabby:

```bash
NODE_PATH='<repo>/app/node_modules' TABBY_PLUGINS= TABBY_DEV=1 TABBY_CONFIG_DIRECTORY="$P" \
  ./node_modules/electron/dist/electron.exe \
  --user-data-dir="$P" --remote-debugging-port=<free port> app --hidden
```

`delimitedLinks.cdp.js` also needs the handlers, so launch it the same way as
`wslPath.cdp.js`. It writes each sample on a fresh row of a real xterm and asks
the real provider for that row, then looks every column up through the ranges it
got back — which is the only way to exercise the line window, the string-index →
buffer-position mapping and the priority arbitration against every `LinkHandler`
at once.

`clicks.cdp.js` dispatches real `mousemove`/`mousedown`/`mouseup` at a link's own
cell rather than calling the decorator's callbacks, because everything it covers
lives in the wiring: which listener sees a press, whether a drag counts as a
click, and whether a gesture reaches the terminal underneath. Two consequences
worth knowing before editing it:

- It **turns `terminal.rightClick` and `terminal.pasteOnMiddleClick` off** for the
  run and puts them back. Both fire on the same presses a chord does, and the
  second pastes the real clipboard into the terminal — not something a test may
  do to a machine.
- It **hides the card before every click.** The card is deliberately never
  rebuilt while it is open, and the settings it was built from are what a click
  on it uses — so a case that changes a rule and clicks again would otherwise
  measure the previous case's answer. A person moves the pointer away and back;
  this does the same.

`wslPath.cdp.js` needs the link handlers, so launch it with
`--enable links,linkifier`. It fakes a tab's profile rather than opening a WSL
session — and it replaces the whole `profile` object, because `profile.options`
is a `ConfigProxy` member and an assignment to it goes to the config file and
comes straight back as what it was.

`pane.cdp.js` opens the pane the way a person does — a real hover, then a real click on the card's
own button — and then asserts three things that are not about how it looks. That a plugin's `html`
document is **exactly** as sealed there as on the card, because a second host is precisely how that
guarantee would quietly stop holding. That hover cards go quiet while a pane is open and come back
when it closes. And that nothing loops: an `*ngFor` over a method that builds objects has frozen
this window before, and that failure does not fail a test, it *hangs* one — so change-detection
passes over the pane are counted while it sits idle (measured: 0 over 2.5s) and the renderer is
pinged with a deadline, the way `integrationsFreeze.cdp.js` does it.

Pass `TABBY_CONFIG_DIRECTORY` so the suites can read the profile they are driving. `html.cdp.js`
is where the sandbox is asserted — **that the frame's `sandbox` is exactly `allow-scripts` and
that `allow-same-origin` is absent is the single most important assertion in this package.**

These run against a *reused* profile that may hold real settings someone typed. Write them to
establish whatever state they assert on and put it back afterwards; do not assume a clean one.
That extends to the *DOM*: `presets.cdp.js` closes any open dropdown before it opens one, because
a caret is a toggle and a menu another run left open makes the next click close it.

**`element.click()` does not close an ng-bootstrap dropdown.** It closes on a `mousedown`/`mouseup`
pair, which a synthetic `click` never produces — so picking a menu item that way fires the handler
and leaves the menu open, which nothing a person does ever produces. Dispatch all three events.
`presets.cdp.js` has the helper; it passed and failed on alternate runs until this was found.

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
