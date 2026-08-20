// Imported before zone.js and before any plugin, so that the timers the stall
// detector runs on are the native ones (a zone-patched interval would schedule
// a change detection pass on every tick, and would stop reporting at exactly
// the moment the zone is what is wedged) and so that the `fs` wrapper is in
// place before plugin code gets to call it.
import { installDiagnostics } from '../lib/diagnostics'

installDiagnostics('renderer')
