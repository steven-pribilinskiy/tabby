import * as builtinFs from 'fs'

/**
 * Node's `fs`, without Electron's asar layer.
 *
 * Electron patches `fs` so that an `.asar` archive looks like a directory —
 * and the *first* patched call on one (`lstat`, `stat`, `access`, `readdir`,
 * any of them) opens that archive and caches it for the life of the process,
 * holding a file handle. Everything here walks other people's builds, and
 * every packaged build has an `app.asar`, so merely measuring a build's size
 * was enough to make that build undeletable for the rest of the session:
 *
 *     EBUSY: resource busy or locked, rmdir '…\resources\app.asar'
 *
 * `rmdir`, because the patched `lstat` calls the archive a directory; `EBUSY`,
 * because the handle pinning it is our own — so no amount of retrying, and no
 * later `process.noAsar`, could ever have cleared it.
 *
 * `original-fs` is Electron's own escape hatch for exactly this: the real
 * module, no asar layer. Archives are never opened, `lstat` calls one a file,
 * and `fs.rm` unlinks it like anything else. It is required through the
 * runtime's own `require` — webpack would try to bundle a static import, and
 * this is a builtin only Electron has.
 */
function load (): typeof builtinFs {
    try {
        // `window.nodeRequire` is the runtime's own require, set by index.pug
        // before anything loads — the same handle tabby-core uses. A static
        // import would not do: webpack would try to bundle a builtin only
        // Electron has.
        return window['nodeRequire']('original-fs')
    } catch {
        // Not running under Electron: the patched behaviour is then the only
        // behaviour there is, and there are no archives to trip over either.
        return builtinFs
    }
}

export const nodeFs = load()
export const fs = nodeFs.promises
