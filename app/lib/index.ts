// Registers main-process error logging - must be first so it catches import-time errors
import './errors'
import { installDiagnostics, mark, recordFailure } from './diagnostics'

import { app, ipcMain, Menu } from 'electron'

// Dev mode has only ever been expressible as an environment variable, and a
// Windows shortcut cannot carry one — so a build run from source could not be
// pinned to the taskbar or launched from anywhere but a prepared shell. Read
// before anything else imports, since './portable' and the plugin loader both
// branch on it.
if (process.argv.includes('--dev')) {
    process.env.TABBY_DEV = '1'
}

// set userData Path on portable version
import './portable'

// set defaults of environment variables
import 'dotenv/config'
process.env.TABBY_PLUGINS ??= ''
process.env.TABBY_CONFIG_DIRECTORY ??= app.getPath('userData')

// Once the config directory is settled there is somewhere to write, and every
// renderer forked from here inherits it. A blocked main process freezes every
// window through synchronous IPC, so it is watched on the same terms as one.
installDiagnostics('main')

app.on('render-process-gone', (_event, _contents, details) => {
    recordFailure('render-process-gone', `${details.reason} (exit ${details.exitCode})`)
})
app.on('child-process-gone', (_event, details) => {
    recordFailure('child-process-gone', `${details.type}/${details.name ?? '?'}: ${details.reason}`)
})

import 'source-map-support/register'
import './sentry'
import './lru'
import { parseArgs } from './cli'
import { Application } from './app'
import electronDebug from 'electron-debug'
import { loadConfig } from './config'
import { fatalStartupError } from './fatal'
import { armBootWatchdog } from './watchdog'

const argv = parseArgs(process.argv, process.cwd())

// eslint-disable-next-line @typescript-eslint/init-declarations
let configStore: any

try {
    configStore = loadConfig()
} catch (err) {
    // Never returns: this runs before `app.ready`, where nothing is armed that
    // could end the process afterwards, so it exits on its own.
    fatalStartupError('config-load-failed', 'Could not read config', err)
}

process.mainModule = module

const application = new Application(configStore)

// Register tabby:// URL scheme
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('tabby', process.execPath, [process.argv[1]])
    }
} else {
    app.setAsDefaultProtocolClient('tabby')
}

ipcMain.on('app:new-window', (_event, options?: { initialTab?: any }) => {
    application.newWindow(options)
})

process.on('uncaughtException', err => {
    recordFailure('uncaughtException', err)
    application.broadcast('uncaughtException', err)
})

if (argv.d) {
    electronDebug({
        isEnabled: true,
        showDevTools: true,
        devToolsMode: 'undocked',
    })
}

app.on('activate', async () => {
    if (!application.hasWindows()) {
        application.newWindow()
    } else {
        application.focus()
    }
})

// Handle URL scheme on macOS
app.on('open-url', async (event, url) => {
    event.preventDefault()
    console.log('Received open-url event:', url)
    if (!application.hasWindows()) {
        process.argv.push(url)
    } else {
        await app.whenReady()
        application.handleSecondInstance([url], process.cwd())
    }
})

app.on('second-instance', (_event, newArgv, cwd) => {
    application.handleSecondInstance(newArgv, cwd).catch(err => {
        recordFailure('second-instance-failed', err)
    })
})

if (!app.requestSingleInstanceLock()) {
    app.quit()
    app.exit(0)
}

app.on('ready', async () => {
    if (process.platform === 'darwin') {
        app.dock.setMenu(Menu.buildFromTemplate([
            {
                label: 'New window',
                click () {
                    this.app.newWindow()
                },
            },
        ]))
    }

    try {
        mark('app-ready')
        application.init()

        // Before the window, because the window is what it waits for. From here
        // this process holds the single-instance lock, so if it cannot produce
        // a working window it has to quit rather than swallow every relaunch.
        armBootWatchdog()

        const window = await application.newWindow({ hidden: argv.hidden })
        mark('window-created')
        await window.ready
        mark('window-ready')
        window.passCliArguments(process.argv, process.cwd(), false)
        window.focus()
    } catch (err) {
        // Records it, releases the single-instance lock, shows it to anyone who
        // is there without blocking the loop, and leaves the quitting to the
        // watchdog armed above. The blocking box that used to stand here is
        // what stopped that watchdog from ever firing.
        fatalStartupError('window-open-failed', 'Tabby failed to start', err)
    }
})
