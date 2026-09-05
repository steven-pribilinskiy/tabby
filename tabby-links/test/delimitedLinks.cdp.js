// `<uri|label>` in a real terminal: what every column of the construct resolves
// to, and what it does to the bare-URI match nested inside it.
//
//   node scripts/dev/launch-hidden.mjs --enable links,linkifier --port 9242
//   CDP_PORT=9242 node tabby-links/test/delimitedLinks.cdp.js
//
// The pattern itself is covered in `delimitedLinks.test.js`. What only the app
// can answer is the part that matters: text is written to a real xterm buffer,
// the real provider is asked for that row, and each column is looked up through
// the ranges it returned. That exercises the line window, the string-index →
// buffer-position mapping and the priority arbitration between our match and
// every `LinkHandler` — none of which exists outside a terminal.
const { connect } = require('./cdp')

let passed = 0
let failed = 0
function check (name, actual, expected) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e) {
        passed++
        console.log(`  ok   ${name}`)
    } else {
        failed++
        console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`)
    }
}
function note (text) {
    console.log(`       ${text}`)
}

const ROOT = `window.ng.getComponent(document.querySelector('app-root'))`

// A restored-but-never-rendered tab has an xterm but no provider of ours, so
// the terminal is selected on the decorator having state for it.
const HARNESS = `
    const cmp = ${ROOT}
    const all = cmp.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
    const decorator = all.flatMap(t => t.decorators || [])
        .find(d => d.constructor.name === 'LinkTooltipDecorator')
    if (!decorator) { throw new Error('decorator not attached to any terminal') }
    const term = all.find(t => decorator.states.has(t))
    if (!term) { throw new Error('no terminal with our provider attached') }
    const state = decorator.states.get(term)
    const xterm = state.xterm

    // Each sample is written on its own fresh row, so the line window around it
    // is exactly what was written and nothing the shell happened to print.
    const writeRow = async (text) => {
        await new Promise(r => xterm.write('\\r\\n' + text, r))
        const buf = xterm.buffer.active
        const lineIndex = buf.baseY + buf.cursorY
        const row = buf.getLine(lineIndex).translateToString(true)
        // \`computeLinks\` takes xterm's 1-based row, as \`provideLinks\` is given it.
        const links = (decorator.computeLinks(state, lineIndex + 1) || [])
            .map(l => ({ text: l.text, range: l.range }))
        return { row, links }
    }

    // xterm ranges are 1-based and inclusive on both ends except that \`end.x\`
    // is the last covered column. Single rows only here, which is all these
    // samples are.
    const covering = (links, column1) => links.filter(l =>
        l.range.start.y === l.range.end.y
        && column1 >= l.range.start.x && column1 <= l.range.end.x)

    // What the whole row resolves to, column by column: null where nothing is
    // claimed, the link's text where something is.
    const columns = (sample) => {
        const out = []
        for (let c = 0; c < sample.row.length; c++) {
            const hit = covering(sample.links, c + 1)
            out.push(hit.length === 1 ? hit[0].text : hit.length === 0 ? null : 'AMBIGUOUS')
        }
        return out
    }
`

const SLACK = '<https://github.com/o/r/pull/9962|repo#9962>'
const SLACK_URI = 'https://github.com/o/r/pull/9962'

async function main () {
    const { evaluate, close } = await connect()

    console.log('\n── a Slack-style link, column by column ──')
    const slack = await evaluate(`
        ${HARNESS}
        const sample = await writeRow(${JSON.stringify(SLACK)})
        return {
            row: sample.row,
            links: sample.links,
            columns: columns(sample),
            afterTheBracket: covering(sample.links, sample.row.length + 1).map(l => l.text),
        }
    `)
    check('the row holds what was written', slack.row, SLACK)
    check('exactly one link on the row', slack.links.length, 1)
    check('every column of the construct resolves to the URI, brackets included',
        slack.columns, new Array(SLACK.length).fill(SLACK_URI))
    check('and nothing is claimed past the closing bracket', slack.afterTheBracket, [])
    note(`range ${JSON.stringify(slack.links.map(l => l.range))}`)
    // The point of the port: before this, columns 0 and 33..42 were null and the
    // label was part of no link at all.
    note(`label columns ${SLACK.indexOf('|')}..${SLACK.length - 1} now resolve to ${slack.columns[SLACK.length - 2]}`)

    console.log('\n── the shapes around it ──')
    const shapes = await evaluate(`
        ${HARNESS}
        const one = async (text) => {
            const sample = await writeRow(text)
            const cols = columns(sample)
            return { row: sample.row, cols, distinct: [...new Set(cols)] }
        }
        return {
            noLabel: await one('<https://www.contoso.com/a>'),
            spacedLabel: await one('<https://www.contoso.com/b|click here please>'),
            unterminated: await one('<https://www.contoso.com/c and then some prose'),
            beside: await one('<https://www.contoso.com/e|e> https://www.contoso.com/d'),
            bare: await one('https://www.contoso.com/d'),
            notALink: await one('cat <file.txt >out.txt'),
        }
    `)

    check('a bracketed URI with no label covers every column',
        shapes.noLabel.distinct, ['https://www.contoso.com/a'])
    check('a spaced label is covered too',
        shapes.spacedLabel.distinct, ['https://www.contoso.com/b'])

    // The bare-URI handler still owns an unterminated one, exactly as before.
    const unterm = shapes.unterminated
    check('an unterminated bracket leaves the bare URI to the handler',
        unterm.cols[5], 'https://www.contoso.com/c')
    check('and the opening bracket is not part of it', unterm.cols[0], null)
    check('and the prose after it belongs to no link', unterm.cols[40], null)

    check('a delimited link and a bare one on the same row do not interfere',
        beside(shapes.beside), ['https://www.contoso.com/e', null, 'https://www.contoso.com/d'])
    check('a bare URI on its own is unchanged',
        shapes.bare.distinct, ['https://www.contoso.com/d'])
    check('a shell redirect is still not a link', shapes.notALink.distinct, [null])
    note(`unterminated: ${JSON.stringify(unterm.distinct)}`)

    console.log('\n── it opens what it says it opens ──')
    const clicked = await evaluate(`
        ${HARNESS}
        const sample = await writeRow(${JSON.stringify(SLACK)})
        const link = decorator.computeLinks(state, xterm.buffer.active.baseY + xterm.buffer.active.cursorY + 1)[0]
        // \`computeLinks\` hands back closures, not the HoveredLink; rebuild the
        // one \`activate\` is given the same way the provider does.
        const opens = []
        const handles = []
        const savedOpen = decorator.actions.open
        const savedHandles = decorator.handlers.map(h => h.handle)
        decorator.actions.open = (uri, filePath) => { opens.push([uri, filePath]) }
        decorator.handlers.forEach(h => { h.handle = (uri) => { handles.push([h.constructor.name, uri]) } })
        try {
            link.activate({})
            await new Promise(r => setTimeout(r, 300))
        } finally {
            decorator.actions.open = savedOpen
            decorator.handlers.forEach((h, i) => { h.handle = savedHandles[i] })
        }
        return { text: link.text, opens, handles }
    `)
    check('the link carries the URI, not the construct', clicked.text, SLACK_URI)
    check('and clicking it reaches the handler the bare URI would have used',
        clicked.handles, [['URLHandler', SLACK_URI]])
    check('without being rerouted', clicked.opens, [])

    close()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}

// The three regions of `<…|e> https://…/d`: the construct, the space, the bare URI.
function beside (sample) {
    const construct = sample.row.indexOf('>') + 1
    return [sample.cols[0], sample.cols[construct], sample.cols[sample.row.length - 1]]
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
