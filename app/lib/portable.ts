import * as path from 'path'
import * as fs from 'fs'
import * as electron from 'electron'

const appPath = path.dirname(electron.app.getPath('exe'))

const portableData = path.join(appPath, 'data')
if (fs.existsSync(portableData)) {
    console.log('reset user data to ' + portableData)
    electron.app.setPath('userData', portableData)

    // A portable install must be self-contained no matter what launched it.
    // Tabby exports TABBY_CONFIG_DIRECTORY and NODE_PATH into its own terminals,
    // so starting a portable copy from a shell inside another Tabby otherwise
    // inherits them: the config is read from the *other* install's directory,
    // and findPlugins() picks up its builtin-plugins through NODE_PATH via
    // nodeModule.globalPaths. Mixing two installs' plugins loads a foreign
    // tabby-core against this one and bootstrap hangs. index.ts assigns
    // TABBY_CONFIG_DIRECTORY with ??=, so an inherited value would win — force
    // it here instead.
    process.env.TABBY_CONFIG_DIRECTORY = portableData
    delete process.env.NODE_PATH
    delete process.env.TABBY_PLUGINS
}
