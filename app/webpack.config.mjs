import * as fs from 'fs'
import * as path from 'path'
import wp from 'webpack'
import * as url from 'url'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

import { AngularWebpackPlugin } from '@ngtools/webpack'
import { execSync } from 'child_process'
import { createEs2015LinkerPlugin } from '@angular/compiler-cli/linker/babel'

// Baked in so a running instance can say which build it is — with several
// frozen build slots around, "which one am I using?" is otherwise unanswerable.
const gitDescribe = (cmd, fallback) => {
    try {
        return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
        return fallback
    }
}
const BUILD_SHA = gitDescribe('git rev-parse --short HEAD', 'unknown')
const BUILD_BRANCH = gitDescribe('git rev-parse --abbrev-ref HEAD', 'unknown')
const pad = n => String(n).padStart(2, '0')
const buildTime = new Date()
const BUILD_DATE = `${buildTime.getFullYear()}-${pad(buildTime.getMonth() + 1)}-${pad(buildTime.getDate())} ${pad(buildTime.getHours())}:${pad(buildTime.getMinutes())}`
// Epoch millis too, so "N ago" is computed from an unambiguous instant rather
// than by re-parsing a formatted local-time string.
const BUILD_TIMESTAMP = buildTime.getTime()
const BUILD_DESCRIBE = gitDescribe('git describe --tags', '')

// The same provenance, written next to the bundle. The DefinePlugin constants
// below can only be read from inside a running instance; the Builds settings
// page has to answer "what was this compiled from?" for builds that are sitting
// on disk not running, and grepping 5 MB of JavaScript for string literals is
// not an answer.
try {
    const distDir = path.resolve(__dirname, 'dist')
    fs.mkdirSync(distDir, { recursive: true })
    fs.writeFileSync(path.join(distDir, 'build-info.json'), JSON.stringify({
        sha: BUILD_SHA,
        branch: BUILD_BRANCH,
        describe: BUILD_DESCRIBE,
        date: BUILD_DATE,
        timestamp: BUILD_TIMESTAMP,
    }, null, 2))
} catch {
    // Provenance is a nicety; never fail a build over it.
}
const linkerPlugin = createEs2015LinkerPlugin({
    linkerJitMode: true,
    fileSystem: {
        resolve: path.resolve,
        exists: fs.existsSync,
        dirname: path.dirname,
        relative: path.relative,
        readFile: fs.readFileSync,
    },
})

export default () => ({
    name: 'tabby',
    target: 'node',
    entry: {
        'index.ignore': 'file-loader?name=index.html!pug-html-loader!' + path.resolve(__dirname, './index.pug'),
        sentry: path.resolve(__dirname, 'lib/sentry.ts'),
        preload: path.resolve(__dirname, 'src/entry.preload.ts'),
        bundle: path.resolve(__dirname, 'src/entry.ts'),
    },
    mode: process.env.TABBY_DEV ? 'development' : 'production',
    optimization:{
        minimize: false,
    },
    context: __dirname,
    devtool: 'source-map',
    output: {
        path: path.join(__dirname, 'dist'),
        pathinfo: true,
        filename: '[name].js',
        publicPath: 'auto',
    },
    resolve: {
        modules: ['src/', 'node_modules', '../node_modules', 'assets/'].map(x => path.join(__dirname, x)),
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.(m?)js$/,
                loader: 'babel-loader',
                options: {
                    plugins: [linkerPlugin],
                    compact: false,
                    cacheDirectory: true,
                },
                resolve: {
                    fullySpecified: false,
                },
            },
            {
                test: /\.ts$/,
                use: {
                    loader: '@ngtools/webpack',
                },
            },
            { test: /\.scss$/, use: ['style-loader', 'css-loader', 'sass-loader'] },
            { test: /\.css$/, use: ['style-loader', 'css-loader', 'sass-loader'] },
            {
                test: /\.(png|svg|ttf|eot|otf|woff|woff2)(\?v=[0-9]\.[0-9]\.[0-9])?$/,
                type: 'asset',
            },
        ],
    },
    externals: {
        '@electron/remote': 'commonjs @electron/remote',
        child_process: 'commonjs child_process',
        electron: 'commonjs electron',
        fs: 'commonjs fs',
        module: 'commonjs module',
        mz: 'commonjs mz',
        path: 'commonjs path',
    },
    plugins: [
        new wp.optimize.ModuleConcatenationPlugin(),
        new wp.DefinePlugin({
            'process.type': '"renderer"',
            'process.env.TABBY_BUILD_SHA': JSON.stringify(BUILD_SHA),
            'process.env.TABBY_BUILD_BRANCH': JSON.stringify(BUILD_BRANCH),
            'process.env.TABBY_BUILD_DATE': JSON.stringify(BUILD_DATE),
            'process.env.TABBY_BUILD_TIMESTAMP': JSON.stringify(String(BUILD_TIMESTAMP)),
        }),
        new AngularWebpackPlugin({
            tsconfig: path.resolve(__dirname, 'tsconfig.json'),
            directTemplateLoading: false,
            jitMode: true,
        })
    ],
})
