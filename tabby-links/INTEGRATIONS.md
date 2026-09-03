# Link previews and integration plugins

Hovering a link (or a piece of plain text that a rule recognizes) in the terminal can show a
card with live information pulled from an external tool — a Jira issue's summary and status, a
Slack message's author and text, a stith session's name and state. This is driven by
**integration plugins**: small JSON manifests that describe how to recognize a match, how to
fetch data for it, and how to display the result. Three ship built in: **Jira**, **Slack**, and
**stith**.

The manifest format is deliberately shared with the Windows Terminal fork
(`steven-pribilinskiy/terminal`, `doc/link-previews-and-integrations.md`). A manifest written
for one works unmodified in the other; see [Differences](#differences-from-the-windows-terminal-fork)
for the two places the apps necessarily diverge.

## What a link preview is

Hover a hyperlink (or a text match) that a plugin recognizes, and the hyperlink card grows a
section below the link target: the plugin's name, then a small set of fields fetched from that
tool. The card shows a spinner while the fetch is in flight, and caches the result for the
plugin's configured lifetime so a second hover is instant.

If the plugin isn't configured (missing a required setting or credential), nothing is fetched
and no preview section appears at all — an unconfigured integration is silent, not erroring. If
a fetch fails, the card shows the error inline (for example, `Jira: 401 Unauthorized`); the card
stays usable, just without a preview.

## Built-in plugins

| Plugin | Recognizes | Needs | Notes |
|---|---|---|---|
| **Jira** | `https://<host>/browse/<KEY>` links, and (opt-in) issue keys like `CAB-8209` in plain text | Site host (setting) + account email and API token (credentials) | Credentials are only ever sent to the configured host — see [Host guarding](#host-guarding). Create an API token at `id.atlassian.com` → Security → API tokens. |
| **Slack** | `https://<workspace>.slack.com/archives/<channel>/p<ts>` permalinks, including thread replies (`?thread_ts=`) | A bot token (credential) | The token needs the `channels:history`, `groups:history` and `users:read` scopes, and the bot must be a member of the channel it's reading. |
| **stith** | `stith://session/<id>`, `stith://focus/<id>`, and `https://<server>/(s\|agent\|sessions\|embed/s)/<id>` links | Server URL (setting) | No credentials. Its fetch step allows an untrusted certificate, so a self-signed `lvh.me` cert doesn't block the preview. |

Each plugin's fields can be trimmed on the Integrations settings page.

## The Integrations settings page

Settings → **Integrations** lists every discovered plugin with its source and an enable toggle.
Opening one shows:

- **Settings** — plain, non-secret values like a site host. Stored in `config.yaml` under
  `integrations`. A field can ask to be tidied up when it loses focus — Jira's Site host does,
  so pasting any URL from the site reduces it to the host and typing `acme` gives you
  `acme.atlassian.net`.
- **Credentials** — one box per credential field. A **secret** field is masked, never shown
  back, and once saved is described by a preview like `ATAT••••••••wxyz` so you can tell which
  value is stored without reading it. A field marked `"secret": false` — Jira's account email —
  is shown in full and stays editable, because there is nothing to protect and an account name
  you cannot read is one you have to guess at. Either way the value is encrypted and stored
  outside `config.yaml`.
- **Show in tooltip** — a checkbox per display field. The first edit seeds from the manifest's
  own defaults, and the chosen set is always re-sorted into manifest order.
- **Detect in output** — the plugin's *suggested* text matchers, each with **Add as rule**,
  which creates the matching Link Tooltip rule for you.
- **Source** — read-only, either `built-in` or the path of the manifest it was loaded from.

### Where configuration lives

Non-secret settings and field selections go in `config.yaml` under a top-level `integrations`
object keyed by plugin id:

```yaml
integrations:
  jira:
    enabled: true
    settings:
      host: acme.atlassian.net
    fields: [summary, status, assignee, updated]
```

- `enabled` — whether the plugin is used for matching and preview at all.
- `settings` — the plugin's non-secret setting values, keyed by the manifest's setting `key`.
- `fields` — the display field keys to show, in order. Omit it to use the manifest's own
  `"default": true` fields.

### Where credentials live

Credentials are **never** written to `config.yaml` — Config Sync uploads that file verbatim.
They are encrypted with the OS keystore (DPAPI on Windows, Keychain on macOS, a keyring on
Linux) via Electron's `safeStorage`, and the ciphertext is stored beside the config:

```
<config directory>/integration-credentials.json
{ "jira": { "email": "<base64>", "token": "<base64>" } }
```

Encryption happens in the main process (`app/lib/secrets.ts`). On a system with no keystore
(`safeStorage.isEncryptionAvailable()` false — Linux without a keyring), the page says so and
refuses to save rather than writing anything in the clear.

## Text matching

Link previews aren't limited to real hyperlinks. A **Link Tooltip rule** with `match: text`
turns a regular expression into a hoverable, clickable match anywhere it appears in terminal
output.

Jira's built-in text matcher recognizes issue keys like `CAB-8209`. Once a text rule for it is
enabled, any matching text becomes hoverable: the card shows the same Jira preview a real
`/browse/` link would, Open navigates to the issue, and Copy link copies its URL.

Rules of the road:

- Text patterns are scanned over the hovered line's wrapped window, capped at 512 characters.
- Up to **16** text patterns can be active at once.
- The **first enabled rule** (in list order) whose criteria match wins — overrides from several
  matching rules are not merged.
- Every pattern is time-boxed. A pattern that is slow enough to be dangerous is refused when it
  is saved and again when it is compiled, so a rule pasted into `config.yaml` by hand is checked
  too. See [Pattern safety](#pattern-safety).

### Rule fields relevant to previews

| Key | Values | Meaning |
|---|---|---|
| `match` | `link` (default) \| `text` | Whether `pattern` runs against a detected/OSC 8 hyperlink's URI, or is scanned over plain terminal text. |
| `pattern` | regex string | Link rules: searched in the link text. Text rules: scanned over the buffer; the whole match becomes the hoverable text. |
| `integration` | `''` (auto) \| `none` \| a plugin id | Which plugin previews a match. Empty lets the plugins' own matchers decide; `none` disables preview for anything this rule matches. |
| `preview` | boolean, default `true` | Whether to show a preview at all. |

## Writing a plugin manifest

A plugin is one folder containing `integration.json`, under:

```
<config directory>/integrations/<folder>/integration.json
```

(A bare `<name>.json` directly in that folder is also picked up.) Discovery order is: built-ins
first, then the user directory — **a user manifest with the same `id` replaces a built-in of the
same id**, so a plugin can be forked, edited, and dropped in place of a shipped one. The registry
re-scans on every settings reload; a manifest that fails to parse is skipped and logged, never
fatal.

### Full annotated example (Jira)

```jsonc
{
    "id": "jira",
    "name": "Jira",
    "icon": "",
    "version": 1,
    "cacheSeconds": 300,

    // Plain values the user fills in. Stored in config.yaml.
    "settings": [
        {
            "key": "host",
            "label": "Site host",
            "placeholder": "acme.atlassian.net",
            "description": "…",
            "required": true,
            // Tidy-up applied when the field loses focus.
            "normalize": "host",
            "suffix": ".atlassian.net"
        }
    ],

    // Secret values. Encrypted with the OS keystore, never in config.yaml.
    // A credential is secret unless it sets "secret": false, or its key is
    // "email", "user" or "username".
    "credentials": [
        { "key": "email", "label": "Account email", "secret": false },
        { "key": "token", "label": "API token", "secret": true }
    ],

    // How this plugin claims a link or a piece of text.
    "matchers": [
        {
            "kind": "link",
            "pattern": "^https?://[^/]+/browse/(?<key>[A-Z][A-Z0-9]+-\\d+)",
            // The hovered URI's host must equal the "host" setting's value.
            "hostSetting": "host"
        },
        {
            "kind": "text",
            "pattern": "\\b(?<key>[A-Z][A-Z0-9]{1,9}-\\d{1,7})\\b",
            "suggested": true,
            "description": "Issue keys in output, like CAB-8209",
            // How a text match becomes a URL for Open / Copy link / click.
            "link": "https://{{settings.host}}/browse/{{key}}"
        }
    ],

    // Steps run in order; a later step can read an earlier one's result
    // through {{stepId:/json/pointer}}.
    "fetch": [
        {
            "id": "issue",
            "type": "http",
            "method": "GET",
            "url": "https://{{settings.host}}/rest/api/3/issue/{{key}}?fields=summary,status",
            "auth": { "type": "basic", "user": "{{credentials.email}}", "password": "{{credentials.token}}" },
            "headers": { "Accept": "application/json" },
            "timeoutMs": 8000
        }
    ],

    // The card's field list. "default": true fields show unless the user
    // picks a different set.
    "fields": [
        { "key": "summary", "label": "Summary", "path": "/fields/summary", "kind": "title", "default": true },
        { "key": "status", "label": "Status", "path": "/fields/status/name", "kind": "badge",
          "colorPath": "/fields/status/statusCategory/colorName", "default": true }
    ]
}
```

### Manifest reference

Top-level keys: `id` (required — a manifest without one is invalid), `name`, `icon`, `version`
(informational), `cacheSeconds`, `settings`, `credentials`, `matchers`, `fetch`, `fields`, and
`html` (reserved; see below). **Unknown keys are ignored**, which is what lets the format grow.

#### Settings / credentials fields

| Key | Meaning |
|---|---|
| `key` | Referenced from templates as `{{settings.<key>}}` / `{{credentials.<key>}}`. |
| `label` | Shown on the Integrations page. Defaults to `key`. |
| `placeholder` | Placeholder text for the input. |
| `description` | Help text under the field. |
| `required` | Settings only: the plugin is not contacted until this has a value. Every declared *credential* is required in practice. |
| `secret` | Credentials only. Defaults to `true` unless the key is `email`, `user` or `username`. A non-secret credential is shown back in full; a secret one is masked and only ever previewed. |
| `normalize` | Settings only. `"host"` reduces whatever was entered to a bare hostname, so a pasted URL works. Applied on blur. |
| `suffix` | Settings only. Appended when the entered value has no dot — `acme` → `acme.atlassian.net`. |

#### Matchers

| Key | Meaning |
|---|---|
| `kind` | `link` or `text`. |
| `pattern` | Regex. Named capture groups (`(?<name>…)`) become template variables. |
| `hostSetting` | **Link matchers only.** The URI's host must equal the named setting's current value. See [Host guarding](#host-guarding). |
| `link` | **Text matchers only.** How a text match turns into a URL. |
| `suggested` | **Text matchers only.** Offered on the Integrations page as "Add as rule". |
| `description` | Shown next to a suggested matcher. |

#### Fetch steps

| Key | Meaning |
|---|---|
| `id` | Referenced by later steps and by field `path`s as `<id>:<pointer>`. |
| `type` | `http` (default) or `command` — the latter runs a local process and parses its stdout as JSON. |
| `url`, `method`, `headers`, `body` | `http` only; all templated. `method` defaults to `GET`. |
| `auth` | `http` only. `{ "type": "basic", "user", "password" }`, `{ "type": "bearer", "value" }`, or `{ "type": "header", "header", "value" }`. |
| `allowUntrustedCertificate` | `http` only. Accepts a self-signed certificate for this request. |
| `commandLine`, `stdin` | `command` only; templated. |
| `timeoutMs` | Both. Defaults to `8000`; a value ≤ 0 is reset to the default. |
| `when` / `unless` | Run or skip the step depending on whether the template expands to a non-empty string. |

Slack's manifest uses `when`/`unless` on a shared step id to choose between
`conversations.history` and `conversations.replies` depending on whether the link carried a
`thread_ts`.

#### Display fields

| Key | Meaning |
|---|---|
| `key` | Identifies the field for the user's selection list. Defaults to `label`. |
| `label` | Shown next to the value. |
| `path` | JSON pointer into a fetch result. See [Paths](#paths). |
| `kind` | `text`, `title` (bold, no label, up to 3 lines), `subtitle`, `badge` (a coloured pill), `link`, `image`, `multiline` (up to 6 lines). |
| `iconPath` | Pointer to a URL for a 16 px icon beside the value. |
| `colorPath` / `color` | For `badge`. A literal `color` wins over `colorPath`. |
| `format` | `relativeTime` (`3 h ago`) or `date` (`2026-09-03 14:05`, local). |
| `default` | Shown before the user picks a custom set. |

Badge colours accept `#rrggbb` or a name: `green`/`success`/`done`/`live`/`running`/`active`,
`yellow`/`inprogress`/`warning`/`waiting`/`idle`, `red`/`error`/`failed`/`blocked`/`dead`/`stale`,
`blue`/`info`/`new`/`open`. Anything else — including Jira's `blue-gray` — renders grey. Badges
are drawn translucent over the card's own background so they read in both themes.

### Templates

Every templated string is expanded with `{{…}}`:

| Template | Expands to |
|---|---|
| `{{match}}` | The whole matched text. |
| `{{<name>}}` | A named capture group from the matcher's pattern. |
| `{{uri}}` | The hovered link's full URI. |
| `{{settings.<key>}}` | A configured setting's value. |
| `{{credentials.<key>}}` | A stored credential's value. |
| `{{<stepId>:<json-pointer>}}` | A value from an earlier fetch step's result. |

Only values that come from *data* — capture groups and step results — are percent-encoded, and
only inside a step's `url`. A setting like `https://stith.lvh.me` is a whole scheme and host and
must survive unescaped. An unknown name expands to the empty string, which is what makes
`when`/`unless` work.

### Paths

`path`, `iconPath` and `colorPath` are [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) JSON
pointers, with one extension: **a negative index counts from the end**, so
`message:/messages/-1/text` is "the last message". An unqualified pointer (`/fields/summary`)
resolves against the most recent step that produced parseable JSON; qualify with a step id when
there are several.

## Host guarding

A link matcher's `hostSetting` names one of the plugin's own settings; the hovered URI's host
must equal that setting's **current** value or the matcher does not fire at all — no fetch, and
no credential touched. This is what stops a look-alike link
(`https://evil.example/browse/ABC-1`) from ever seeing a Jira token: the fetch never starts,
because the matcher never matched.

More generally, a plugin's fetch pipeline never runs unless the plugin is **enabled** and every
`required` setting and every declared credential has a value.

## Pattern safety

Rule patterns are matched synchronously, on the mouse-move handler, against text a *remote host*
printed. A catastrophically backtracking pattern is therefore a remotely triggerable freeze —
`(a+)+b` against thirty `a`s takes about twelve seconds.

So every pattern is probed before it can run: it is matched against adversarial inputs at
increasing lengths, stopping at the first length that is even slightly slow. A pattern that fails
is refused with an explanation when you save it, and refused again when it is compiled, so a rule
written straight into `config.yaml` is covered too. If one somehow gets through, it is timed at
runtime and switched off for the session with a notification naming it.

The probe measures rather than pattern-matching on syntax, because the built-in handler regexes
contain nested quantifiers and are perfectly fast — a static "reject nested quantifiers" rule
would refuse Tabby's own defaults.

## Caching

Each plugin's `cacheSeconds` controls how long a resolved preview is kept per matched link — a
second hover within that window skips the fetch entirely. Jira and Slack default to 300 seconds,
stith to 30. Failures are cached for a fixed 30 seconds, so a wrong token doesn't retry on every
hover but recovers within half a minute once fixed. The cache holds at most 256 entries and is
cleared whenever settings reload.

## Differences from the Windows Terminal fork

The manifest format is the same. Two things about the surrounding app are not:

- **Credential storage.** That fork uses the Windows Credential Manager (`PasswordVault`); this
  one uses Electron's `safeStorage` and a sidecar file, because it has to work on three
  platforms. Both keep secrets out of the settings file.
- **Custom tooltip actions.** That fork's rules name an entry in its own `actions` keybinding
  map. Tabby has no equivalent, so a custom action here declares a `type` of `openUrl`,
  `sendInput` or `command` (a Tabby command id) with `%u` substituted for the hovered link —
  the same substitution that fork applies to `SendInput` and `ExecuteCommandline`.

`normalize` and `suffix` on a setting field are additive and, per the "unknown keys are ignored"
rule, harmless to an implementation that has not adopted them yet.

## HTML representation (reserved)

The schema reserves an `html` key for a richer, HTML-rendered card in place of the field list.
It is not implemented in either fork — a manifest that sets it falls back to `fields`.
