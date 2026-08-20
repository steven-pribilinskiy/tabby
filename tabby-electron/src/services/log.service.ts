import * as fs from 'fs'
import * as path from 'path'
import * as winston from 'winston'
import { Injectable } from '@angular/core'
import { ConsoleLogger, Logger } from 'tabby-core'
import { ElectronService } from '../services/electron.service'

const initializeWinston = (electron: ElectronService) => {
    const logDirectory = electron.app.getPath('userData')
    // eslint-disable-next-line
    const winston = require('winston')

    if (!fs.existsSync(logDirectory)) {
        fs.mkdirSync(logDirectory)
    }

    return winston.createLogger({
        transports: [
            new winston.transports.File({
                level: 'debug',
                filename: path.join(logDirectory, 'log.txt'),
                // Timestamped, because the whole value of this file after the
                // fact is lining its entries up against something else — a
                // freeze, a crash, a session that died. `format.simple()`
                // records none, so a five-megabyte log cannot answer "what was
                // happening at 09:58".
                format: winston.format.combine(
                    winston.format.timestamp(),
                    winston.format.printf((info: any) => {
                        // Winston stashes the extra arguments of `log(msg, a, b)`
                        // under a symbol; `format.simple()` renders them and
                        // dropping them here would quietly shorten every entry
                        // that carries a payload.
                        const extra: unknown[] | undefined = info[Symbol.for('splat')]
                        const tail = extra?.length
                            ? ` ${extra.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`
                            : ''
                        return `${info.timestamp} ${info.level}: ${info.message}${tail}`
                    }),
                ),
                handleExceptions: false,
                maxsize: 5242880,
                maxFiles: 5,
            }),
        ],
        exitOnError: false,
    })
}

export class WinstonAndConsoleLogger extends ConsoleLogger {
    constructor (private winstonLogger: winston.Logger, name: string) {
        super(name)
    }

    protected doLog (level: string, ...args: any[]): void {
        super.doLog(level, ...args)
        this.winstonLogger[level](...args)
    }
}

@Injectable({ providedIn: 'root' })
export class ElectronLogService {
    private log: winston.Logger

    /** @hidden */
    constructor (electron: ElectronService) {
        this.log = initializeWinston(electron)
    }

    create (name: string): Logger {
        return new WinstonAndConsoleLogger(this.log, name)
    }
}
