import { ConfigProvider } from 'tabby-core'

/** @hidden */
export class LinksConfigProvider extends ConfigProvider {
    defaults = {
        linkTooltip: {
            /** Master switch for the hover card. Detection stays on. */
            enabled: true,
            /** Whether links are detected and made clickable at all. */
            detectLinks: true,
            maxWidth: 640,
            showDelay: 250,
            hideDelay: 400,
            showButtons: true,
            /**
             * Whether a plugin's own `html` document is rendered. It runs in a
             * sandboxed frame with an opaque origin and a CSP that blocks the
             * network, so it can reach neither Tabby nor the outside — but it is
             * still someone else's script, so there is a switch. Off falls back
             * to the plain field list.
             */
            allowHtml: true,
            /** Extra URI schemes that open without a confirmation dialog. */
            safeSchemes: [],
            rules: [],
        },
        /**
         * Per-integration state, keyed by manifest id:
         * `{ enabled: boolean, settings: {}, fields: [] }`.
         *
         * `__nonStructural` is load-bearing, not decoration. `ConfigProxy` only
         * treats an object as structural when it has keys, so a plain `{}` default
         * falls through to `__getValue`, which hands back a fresh `deepClone` on
         * every read — writes into it are silently discarded. The flag forces the
         * leaf path, where the stored object is returned by reference and mutations
         * persist. Same reason `tabby-terminal/src/config.ts` flags `colorScheme`.
         */
        integrations: {
            __nonStructural: true,
        },
    }

    platformDefaults = { }
}
