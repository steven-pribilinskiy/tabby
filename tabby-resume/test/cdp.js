// The CDP driver, which lives in `scripts/dev/cdp.cjs` because every plugin's
// tests and the app's own need the same one — and because a second copy of it
// is a second place for a hardcoded debugging port to survive. This file stays
// so `require('./cdp')` keeps working, and so a plugin still depends on the
// repo's dev scripts rather than on another plugin's test files.
//
// Nothing is attached to until `/json/version` says Electron. See that file.
module.exports = require('../../scripts/dev/cdp.cjs')
