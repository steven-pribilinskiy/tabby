import { ipcMain, safeStorage } from 'electron'

/**
 * OS-backed encryption for secrets that must not live in `config.yaml`.
 *
 * `config.yaml` is uploaded verbatim by Config Sync, so an API token stored
 * there leaves the machine. Electron's `safeStorage` encrypts against the OS
 * keystore — DPAPI on Windows, the Keychain on macOS, a keyring on Linux — with
 * no passphrase to prompt for, which matters because the only thing that ever
 * needs a secret here is a fetch triggered by hovering a link.
 *
 * This lives in the main process rather than being reached through
 * `@electron/remote` on purpose: `encryptString` returns a **Buffer**, and a
 * Buffer crossing the remote bridge arrives as a plain `Uint8Array`, which
 * `decryptString` then rejects. Doing the base64 on this side means only
 * strings ever cross.
 */
export function initSecrets (): void {
    ipcMain.handle('secrets:available', () => {
        try {
            return safeStorage.isEncryptionAvailable()
        } catch {
            return false
        }
    })

    ipcMain.handle('secrets:encrypt', (_event, plaintext: string) => {
        if (typeof plaintext !== 'string' || !plaintext) {
            return ''
        }
        return safeStorage.encryptString(plaintext).toString('base64')
    })

    ipcMain.handle('secrets:decrypt', (_event, ciphertext: string) => {
        if (typeof ciphertext !== 'string' || !ciphertext) {
            return ''
        }
        try {
            return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
        } catch {
            // A secret encrypted under a different OS user, machine, or keyring
            // cannot be read back. Returning empty makes that look like "not
            // set", which is recoverable; throwing would break the settings page.
            return ''
        }
    })
}
