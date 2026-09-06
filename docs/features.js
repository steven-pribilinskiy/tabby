// The catalogue behind index.html, features.html and feature.html.
// One source of truth: the cards, the filters and the detail pages all read
// this, so they cannot disagree with each other.
//
// The numbers are real. `commits` are the actual short SHAs on `local`, and
// `ins`/`del`/`files` come from git's own diffstat for exactly those commits:
//
//   git show --numstat --format= <sha>...     # ins and del summed
//                                             # files = each commit's own count
//
// `dateAdded` is the earliest commit date in the group. A feature that was
// refined over weeks keeps the date it first landed.
//
// KEEPING THIS CURRENT: when a commit lands on `local` that a reader would
// call a feature, it belongs here — either as a new entry or added to an
// existing one's `commits`, with the diffstat recomputed. A catalogue that has
// stopped tracking the branch is worse than no catalogue.
//
// `local` is rebased onto `master` at every upstream sync, so every SHA below
// changes when that happens and every commit link goes stale at once. Rerun
// `node scripts/dev/check-docs.mjs` after a rebase: it recomputes all of this
// against git and names each entry that no longer matches.
//
// `desc` is plain text and is escaped everywhere it is rendered. The long-form
// prose in feature-details.js may contain inline HTML; this may not.
window.FEATURES = [

  // ---------------------------------------------------------------- links
  {
    id: "link-tooltip", title: "Link hover cards, rules and integrations",
    cat: "links", catLabel: "Links",
    standout: true,
    dateAdded: "2026-09-03",
    commits: ["715eff7e","fba6a5b8","0ae0a6a4","b52d97a2","8e684654","7737ccd5","da8e70a0"],
    files: 56, ins: 6984, del: 33,
    desc: "Hovering a link opens a card that says where it goes, what a click will do, and offers Open, Copy and Show in folder. A Link Tooltip settings page holds rules that customise the card per pattern, and an Integrations page runs declarative integration.json manifests that fetch a preview of what a link actually refers to — a ticket's status, a message, a session. Doing this also repaired Tabby's linkifier, which could never make a file path or a bare IP clickable at all.",
  },
  {
    id: "rich-integrations", title: "Field groups, tabs, actions and detected patterns",
    cat: "links", catLabel: "Links",
    dateAdded: "2026-09-04",
    commits: ["16a21913","ca54df80"],
    files: 31, ins: 3288, del: 131,
    desc: "A manifest can group its fields under headings, carry a description body or a comment list behind a tab strip, offer actions that write back to the service, and name its own patterns to detect. Without these keys a manifest written for the other terminal degraded silently here — which is the real threat to \"one manifest, many terminals\". The four built-in manifests are now held key by key against that fork's copies, at a pinned commit.",
  },
  {
    id: "integration-html", title: "A manifest can bring its own HTML",
    cat: "links", catLabel: "Links",
    dateAdded: "2026-09-04",
    commits: ["51651439","4ba7358b"],
    files: 12, ins: 742, del: 34,
    desc: "An integration may render a complete HTML document in place of the field list, given the data every fetch step returned. It runs in a frame with sandbox=\"allow-scripts\" and nothing else — an opaque origin, no require, no process — behind a CSP that refuses the network outright.",
  },
  {
    id: "preview-pane", title: "A preview you can read, in a pane",
    cat: "links", catLabel: "Links",
    dateAdded: "2026-09-06",
    commits: ["31a979ad"],
    files: 25, ins: 2184, del: 826,
    desc: "A button on the card puts the same preview in a real pane beside the terminal — grouped fields, markdown bodies, comments, actions and a plugin's own HTML — with a switch that silences hover cards while one is open. One renderer component, mounted in two hosts, so the pane cannot end up less sealed than the card.",
  },
  {
    id: "click-chords", title: "What a click does is a chord you choose",
    cat: "links", catLabel: "Links",
    dateAdded: "2026-09-06",
    commits: ["be94a066"],
    files: 17, ins: 1921, del: 70,
    desc: "Two chords, primary and alternative, each a modifier by a gesture by an action — plus which kinds of link a click reaches at all, and a master switch. A rule may override either chord. Upstream's clickableLinks.modifier is migrated onto the primary chord rather than dropped, because it may be sitting in a real config.yaml.",
  },
  {
    id: "rule-presets", title: "A rule starts from a preset, not an empty regex box",
    cat: "links", catLabel: "Links",
    dateAdded: "2026-09-06",
    commits: ["ada258df"],
    files: 8, ins: 949, del: 5,
    desc: "Add rule is a split button whose caret offers eleven ready-made rules, and an Apply preset dropdown rewrites the rule you have open. A preset does not own its pattern: anything an integration already matches takes the pattern from that manifest, so the two cannot drift apart.",
  },
  {
    id: "slack-links", title: "A Slack-style <uri|label> is clickable all the way across",
    cat: "links", catLabel: "Links",
    dateAdded: "2026-09-06",
    commits: ["d8c6df04"],
    files: 6, ins: 585, del: 5,
    desc: "The bracketed form Slack and many CLIs emit is one match at a priority above every handler, so the brackets and the label belong to the link instead of to nothing. The URI is still shown in full — collapsing it to the label would mean the renderer showing text the buffer does not hold.",
  },
  {
    id: "wsl-links", title: "A WSL path resolves before anything asks whether it exists",
    cat: "links", catLabel: "Links",
    dateAdded: "2026-09-06",
    commits: ["ded273ff"],
    files: 7, ins: 596, del: 30,
    desc: "The \\\\wsl.localhost translation was correct and never ran: existence was checked on the path as written, so /home/you/notes.md was asked about as C:\\home\\you\\notes.md, came back false, and the click did nothing. Existence is now asked once, of the path that would actually be opened — and a #L6-L7 fragment is stripped as a fragment rather than carried into the filename.",
  },
  {
    id: "card-clamp", title: "The hover card stays inside the pane",
    cat: "links", catLabel: "Links",
    dateAdded: "2026-09-06",
    commits: ["1944447a"],
    files: 6, ins: 185, del: 14,
    desc: "Clamping where an edge lands does nothing once the card is already wider than the pane it floats over. The width cap is now the lesser of the setting and the hovered screen's own width, written before the card is measured rather than after.",
  },
  {
    id: "url-punctuation", title: ": , and / stay inside a clickable URL",
    cat: "links", catLabel: "Links",
    dateAdded: "2026-06-24",
    commits: ["ddda561b"],
    files: 1, ins: 3, del: 1,
    desc: "Tabby's URL handler dropped a colon, comma or slash from a path or query, so a link to a line number or a list parameter stopped short of where it pointed. Three characters added to two character classes.",
  },

  // --------------------------------------------------------------- claude
  {
    id: "claude-panel", title: "A docked Claude session panel and tab hover cards",
    cat: "claude", catLabel: "Claude Code",
    standout: true,
    dateAdded: "2026-08-09",
    commits: ["19ab52b4","516d2748","7a27741d","07faeba9"],
    files: 66, ins: 3944, del: 140,
    desc: "A panel docked to any edge of the window lists every Claude Code session on the machine — what it is doing, what it last asked, how much of its context window is gone — and a tab's hover card says the same about the session running in that tab. Tabs are joined to sessions by launch directory, never by PID, because a session inside WSL reports Linux PIDs that can never match Tabby's conpty PIDs.",
  },

  // ------------------------------------------------------------- sessions
  {
    id: "session-resume", title: "A pane comes back running what it was running",
    cat: "sessions", catLabel: "Sessions",
    standout: true,
    dateAdded: "2026-09-06",
    commits: ["49960f39"],
    files: 29, ins: 3487, del: 9,
    desc: "Upstream restores the furniture — the tabs, the splits, the profiles, a picture of what was on screen — but every pane comes back as a fresh shell, so the agent you had a two-hour conversation with and the multiplexer holding six sessions are simply not running any more. Each pane is asked what it is running, the answer is persisted with the layout, and it is typed back into the restored pane.",
  },
  {
    id: "window-geometry", title: "Each window remembers where it was",
    cat: "sessions", catLabel: "Sessions",
    dateAdded: "2026-08-10",
    commits: ["0036abab","caab1862"],
    files: 5, ins: 970, del: 25,
    desc: "Upstream keeps one saved rectangle that every window reads and writes, which is invisible with one window and wrong the moment there are two: the second opens exactly on top of the first, and whichever closes last overwrites the other. Geometry is now per window, and a window whose title bar would land off screen is pulled back into a work area instead of being restored somewhere you cannot reach it.",
  },

  // ------------------------------------------------------------- terminal
  {
    id: "xterm6", title: "xterm.js 6, and the canvas renderer retired",
    cat: "terminal", catLabel: "Terminal",
    dateAdded: "2026-09-04",
    commits: ["064409ee","c6dbe9d4","089db01a","63930d05","5129cbb9","09c12b36"],
    files: 17, ins: 862, del: 108,
    desc: "The terminal renders through WebGL on xterm.js 6.0. The canvas renderer is gone — it was last released in April 2024 and xterm 6 deletes it outright — so terminal.frontend: xterm now means xterm's own DOM renderer, slow but always correct, and the fallback for a pane whose WebGL context could not be recovered.",
  },
  {
    id: "contrast-default", title: "Draw the colours the app asked for",
    cat: "terminal", catLabel: "Terminal",
    dateAdded: "2026-08-15",
    commits: ["46c987c4"],
    files: 3, ins: 47, del: 3,
    desc: "terminal.minimumContrastRatio defaulted to 4, and xterm.js rewrites every foreground that misses the ratio — 24-bit ones included. Solarized Light sits at 3–5:1 against a light background, so all thirteen of its colours were pushed toward mud and near-neighbours collapsed onto each other. The default is now 1, xterm's own \"off\" value, while the app chrome keeps its own floor of 4.",
  },
  {
    id: "web-search", title: "Search the web for the selection",
    cat: "terminal", catLabel: "Terminal",
    dateAdded: "2026-09-06",
    commits: ["520447e5"],
    files: 6, ins: 570, del: 0,
    desc: "Right-clicking a selection offers to search for it with whichever engine you configure. The template is parsed twice and the two origins compared, so text a remote host printed into your terminal can never turn the template into a request to a different host.",
  },
  {
    id: "wsl-cwd", title: "A WSL tab knows which directory it is in",
    cat: "terminal", catLabel: "Terminal",
    dateAdded: "2026-08-09",
    commits: ["3c1efe5f","27854014"],
    files: 3, ins: 67, del: 2,
    desc: "Tabby understood iTerm's OSC 1337 but not OSC 7, which is what default bash and zsh — including WSL's — actually emit, so a WSL tab reported no working directory at all. A WSL profile's working directory can also be picked from inside the distro now, rather than typed as a guess.",
  },

  // ------------------------------------------------------------------- ui
  {
    id: "vertical-tabs", title: "Vertical tabs, resizable and multi-column",
    cat: "ui", catLabel: "UI & theming",
    dateAdded: "2026-08-09",
    commits: ["9121d3db","d3562625","03ceb0ea","abcdf1cd"],
    files: 8, ins: 165, del: 4,
    desc: "The side tab bar can be dragged to a width that is remembered, and flows into multiple columns once there is room for a whole one. Tab titles in this fork are paths and session names, which a horizontal strip truncates to nothing, so vertical is the default here.",
  },
  {
    id: "theme-repairs", title: "Light-scheme contrast, borders, and an opaque window",
    cat: "ui", catLabel: "UI & theming",
    dateAdded: "2026-08-09",
    commits: ["97f6ad1a","68e3e76a","1f869527","d16ff175"],
    files: 10, ins: 171, del: 41,
    desc: "Control borders and surface separation come back on light schemes, hover states stay legible, swatches are labelled, and the window gets an opaque backing surface on Windows so a transparent frame does not show the desktop through the chrome.",
  },
  {
    id: "accent-colour", title: "An accent colour, instead of Bootstrap's pink",
    cat: "ui", catLabel: "UI & theming",
    dateAdded: "2026-09-05",
    commits: ["0b435d69"],
    files: 6, ins: 136, del: 6,
    desc: "Every code span in the app — paths, commits, identifiers, the build tooltip — was Bootstrap's #d63384, a pink belonging to no colour scheme here and the last hardcoded accent left in the UI. appearance.accentColor replaces it, and null follows the scheme.",
  },
  {
    id: "splash-scheme", title: "The splash screen follows the OS scheme",
    cat: "ui", catLabel: "UI & theming",
    dateAdded: "2026-09-04",
    commits: ["212bd05d"],
    files: 2, ins: 89, del: 16,
    desc: "The window's backing colour already followed the OS; only the splash CSS was hardcoded dark, so a light desktop got a black flash before the window drew. One appended media block, so the dark path's diff is nil.",
  },
  {
    id: "tab-actions", title: "Split and open-in-new-window for every tab",
    cat: "ui", catLabel: "UI & theming",
    dateAdded: "2026-08-09",
    commits: ["aae34d4d"],
    files: 7, ins: 48, del: 7,
    desc: "The tab context menu offers to split or move out any tab, not only a terminal — and the new window inherits the running session rather than starting a fresh one.",
  },
  {
    id: "build-hint", title: "The tab bar says which build this is",
    cat: "ui", catLabel: "UI & theming",
    dateAdded: "2026-08-09",
    commits: ["a55caba8","031e572e","44740a2a","452d1016"],
    files: 20, ins: 338, del: 31,
    desc: "Running several builds side by side means constantly answering \"which one is this?\". A hint in the tab bar names the build, and its tooltip carries the commit, the branch, how old the build is and the paths it is running from — kept inside the window rather than opening off the edge of the screen.",
  },
  {
    id: "jump-list", title: "The jump list wears each profile's own icon",
    cat: "ui", catLabel: "UI & theming",
    dateAdded: "2026-09-06",
    commits: ["61ab7ae6"],
    files: 6, ins: 1355, del: 25,
    desc: "Upstream already offers your profiles when you right-click Tabby in the taskbar, but gave every entry the app's own icon, so it was a column of identical logos that told you nothing about what you were about to open. Font Awesome glyphs and inline SVG icons are rasterised into real .ico files the shell can read, and an entry is never blank and never dropped.",
  },
  {
    id: "settings-polish", title: "Reset a setting; sliders that commit as you drag",
    cat: "ui", catLabel: "UI & theming",
    dateAdded: "2026-08-14",
    commits: ["87e04771","9fd9ccea"],
    files: 5, ins: 68, del: 3,
    desc: "A setting that is off its default offers to go back, and a range control writes its value as it moves instead of only when the mouse is released — so dragging one previews nothing until you let go, which is exactly backwards.",
  },

  // --------------------------------------------------------------- builds
  {
    id: "builds-page", title: "Every Tabby build on this machine",
    cat: "builds", catLabel: "Builds",
    standout: true,
    dateAdded: "2026-08-10",
    commits: ["9fe5587d","5a999661","fad4b2bb","2c20ac31","be8412bc","81dd27d2","95b0e643","69ae9766","ec3870c4","925a1b2b","d0637cfd","5eacc8cc"],
    files: 75, ins: 4170, del: 178,
    desc: "Settings → Builds lists the installed app, the webpack output this fork runs from, electron-builder output inside a checkout, frozen build slots and installer files — with live process counts, memory and uptime, size on disk, build time, arch, branch and provenance. Processes are attributed by executable path, because two builds both called Tabby.exe are otherwise indistinguishable.",
  },
  {
    id: "builds-doctor", title: "A doctor that says why a build will not start",
    cat: "builds", catLabel: "Builds",
    dateAdded: "2026-08-10",
    commits: ["0b8ed048"],
    files: 10, ins: 568, del: 3,
    desc: "Written after an auto-update deleted nine of the twelve builtin plugin directories and left the app on a splash screen for ever, with Windows reporting the process as responding the whole time. Each build is health-checked on every scan, and one that will not start says so on its own card, with the cause found on disk.",
  },
  {
    id: "build-slots", title: "Two named slots, canary and dev",
    cat: "builds", catLabel: "Builds",
    dateAdded: "2026-08-10",
    commits: ["17cba48d","4da0c3d8","352b5632","57874348","e70f138a"],
    files: 12, ins: 850, del: 155,
    desc: "One script cuts a frozen, self-contained copy of the fork into a slot that runs beside your real Tabby: its own portable profile, shared plugins, no global hotkey and no MCP port to fight over. Exactly two slots — canary is disposable and every build replaces it; dev changes only by promoting the canary you actually tried.",
  },
  {
    id: "active-build", title: "One active build, and the pin that follows it",
    cat: "builds", catLabel: "Builds",
    dateAdded: "2026-08-10",
    commits: ["0a104ef9","f0190334","38212baa","9a7d71db"],
    files: 18, ins: 679, del: 76,
    desc: "Exactly one build is the Tabby you use: it is what the taskbar pin launches, it carries a badge, and it is never deletable — so there is always a working Tabby left on the machine. Nothing here can create a taskbar pin, because Windows removed that verb in 1809, but a Start menu entry can be written and a pin made from it is then kept aimed at the active build.",
  },
  {
    id: "upstream-page", title: "What upstream has that we don't",
    cat: "builds", catLabel: "Builds",
    dateAdded: "2026-09-04",
    commits: ["d54d689f"],
    files: 15, ins: 825, del: 3,
    desc: "Settings → Upstream compares this checkout against the project the fork tracks: how many commits have landed there that are not here, the patch series carried on top, and where each commit is on the web. It never fetches on its own, so how stale the answer is has to be visible, and it is.",
  },

  // ---------------------------------------------------------- diagnostics
  {
    id: "diagnostics-log", title: "Why it froze",
    cat: "diagnostics", catLabel: "Diagnostics",
    standout: true,
    dateAdded: "2026-08-20",
    commits: ["a62c84d0","85510d48","6f43be3c","a959f140"],
    files: 12, ins: 807, del: 15,
    desc: "A frozen window otherwise leaves no trace: Windows calls the process responding, nothing throws, and the app log had no timestamps to line anything up against. Every blocked event loop in the main process and in every renderer is recorded, with the synchronous calls that blocked it tallied by name — because what freezes this app is tens of thousands of individually-fast calls, not one slow one.",
  },
  {
    id: "require-failed", title: "Every module that would not load",
    cat: "diagnostics", catLabel: "Diagnostics",
    dateAdded: "2026-09-04",
    commits: ["0a7060bc"],
    files: 2, ins: 105, del: 4,
    desc: "tabby-electron alone swallows seven require failures in empty catch blocks, so a module that would not resolve left no trace and surfaced later as something unrecognisable. Module._load is wrapped, so the throw is seen before any of those catches reach it, and the error is always rethrown — this observes, it does not change what happens next.",
  },
  {
    id: "render-timing", title: "When it isn't the event loop",
    cat: "diagnostics", catLabel: "Diagnostics",
    dateAdded: "2026-09-04",
    commits: ["16748a9f"],
    files: 10, ins: 427, del: 4,
    desc: "Nothing blocks, the loop stays free, and the screen still lags — because frames are being dropped, or because xterm is taking a long time to lay out what was written to it. Both are timed and tallied into the same log, and a healthy hour writes no lines at all.",
  },

  // ----------------------------------------------------------- robustness
  {
    id: "module-lookup", title: "A build must load its own plugins",
    cat: "robustness", catLabel: "Robustness",
    dateAdded: "2026-08-09",
    commits: ["c5e67743","0b21f324"],
    files: 5, ins: 214, del: 5,
    desc: "A Tabby exports NODE_PATH to every shell it starts, and the module lookup appended its own paths to whatever it inherited — so a Tabby launched from a terminal inside another Tabby resolved tabby-core to the other build's copy: two Angulars, and a boot that stops dead on the splash screen. This build's paths now go first, and the builtins that must not be got wrong are required by absolute path.",
  },
  {
    id: "watchdog", title: "A useless process must not hold the lock",
    cat: "robustness", catLabel: "Robustness",
    dateAdded: "2026-09-06",
    commits: ["bb6e8f59"],
    files: 6, ins: 597, del: 3,
    desc: "Exactly one process answers for the app, so once that process cannot show a window, every later launch is handed to it and silently swallowed — no window, no error, no crash, indefinitely. Six hours of it, measured. A process in which no window has ever reported itself ready has run nothing and holds nothing to lose, and that one rule is what makes quitting safe.",
  },
  {
    id: "fatal-startup", title: "A startup error must not be a modal nobody sees",
    cat: "robustness", catLabel: "Robustness",
    dateAdded: "2026-09-06",
    commits: ["8db54cdc"],
    files: 5, ins: 687, del: 18,
    desc: "dialog.showErrorBox is modal and synchronous — measured, a process showing one ran not a single timer callback in fourteen seconds. So a startup error left a process alive with no window, holding the single-instance lock, unable to run the watchdog that exists for exactly that. The failure is recorded first, the lock released second, and the box shown on its own thread third.",
  },
  {
    id: "config-save", title: "A failed config save is reported, not dropped",
    cat: "robustness", catLabel: "Robustness",
    dateAdded: "2026-08-14",
    commits: ["8ac1165d"],
    files: 1, ins: 23, del: 2,
    desc: "A config file that cannot be written — a read-only file in a mis-frozen build slot, most often — threw before the change event fired, so nothing persisted and nothing driven by that event re-applied either. Settings appeared to do nothing at all, in silence.",
  },
  {
    id: "cdp-safety", title: "A CDP test must prove what it attached to",
    cat: "robustness", catLabel: "Robustness",
    dateAdded: "2026-09-05",
    commits: ["c79ccc1f","befec385"],
    files: 18, ins: 647, del: 346,
    desc: "Chromium does not report a debugging port it could not bind — it just does not listen, and every request then goes to whatever is on that port. Measured here: a test assuming a fixed port attached to the user's own browser, full of logged-in tabs, and only a URL filter stopped it evaluating JavaScript in them. Ports are now found, never assumed, and nothing is attached to until it answers as Electron.",
  },
];
