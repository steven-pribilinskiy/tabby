#!/usr/bin/env node
// Print the modules webpack actually resolved for a package, filtered by a
// substring. Answers "which entry point did it take" without reading a bundle.
//
//   TABBY_DEV=1 node scripts/dev/which-modules.mjs tabby-terminal @xterm
import webpack from 'webpack'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as url from 'node:url'

const root = path.resolve(url.fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const pkg = process.argv[2]
const filter = process.argv[3] ?? ''
const configPath = url.pathToFileURL(path.join(root, pkg, 'webpack.config.mjs')).href
const stats = await promisify(webpack)((await import(configPath)).default())
const names = stats.toJson({ modules: true, reasons: false }).modules
    .map(m => m.name)
    .filter(n => n && n.includes(filter))
console.log(names.join('\n'))
