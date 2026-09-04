#!/usr/bin/env node
// Build a single package's webpack bundle. `yarn build` rebuilds everything,
// which is minutes; iterating on one package is seconds.
//
//   TABBY_DEV=1 node scripts/dev/build-one.mjs tabby-terminal [tabby-linkifier ...]
import webpack from 'webpack'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as url from 'node:url'

const root = path.resolve(url.fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const packages = process.argv.slice(2)
if (!packages.length) {
    console.error('usage: build-one.mjs <package> [package ...]')
    process.exit(2)
}

for (const pkg of packages) {
    const configPath = url.pathToFileURL(path.join(root, pkg, 'webpack.config.mjs')).href
    const started = Date.now()
    const stats = await promisify(webpack)((await import(configPath)).default())
    console.log(stats.toString({ colors: false, modules: false, chunks: false, assets: true, errors: true, warnings: false }))
    console.log(`[${pkg}] ${((Date.now() - started) / 1000).toFixed(1)}s`)
    if (stats.hasErrors()) {
        process.exit(1)
    }
}
