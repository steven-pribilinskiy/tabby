import { Injectable } from '@angular/core'

/** Closed when the operation finishes. Returns its duration in ms. */
export interface DiagnosticSpan {
    end (extra?: unknown): number
}

const NULL_SPAN: DiagnosticSpan = { end: () => 0 }

/**
 * Times named operations, for the delays a stall detector cannot see.
 *
 * The recorder in the app bundle catches work that *blocks* the event loop.
 * That misses the delays users actually report: an operation that spends a
 * second inside `await` leaves the loop free the whole time, so nothing is
 * ever written, even though the window sat there doing nothing. A span covers
 * the wall-clock cost regardless of what it waited on.
 *
 * The recorder lives in the app bundle, which a package cannot import — and
 * should not, since that is the wrong direction of dependency. It publishes
 * itself on the global instead; this service is the typed view of it, and
 * every call is a no-op when it is absent. That is the real state under
 * tabby-web and in tests, so absence must cost nothing and break nothing.
 *
 * Only spans past the recorder's threshold are written, so timing a hot path
 * costs two timestamps.
 */
@Injectable({ providedIn: 'root' })
export class DiagnosticsService {
    /** Looked up per call, not cached: the recorder installs before any of
     *  this exists, but a cached miss would be permanent if that ever changed. */
    private get recorder (): any {
        return (globalThis as any).__tabbyDiagnostics
    }

    get available (): boolean {
        return !!this.recorder
    }

    /** Start timing something. Always returns a span, so callers never branch. */
    span (label: string, detail?: unknown): DiagnosticSpan {
        return this.recorder?.span?.(label, detail) ?? NULL_SPAN
    }

    /** Time an operation and return its result, closing the span either way. */
    async time<T> (label: string, work: () => Promise<T>, detail?: unknown): Promise<T> {
        const span = this.span(label, detail)
        try {
            return await work()
        } finally {
            span.end()
        }
    }

    /** Note something worth seeing next to a stall or a slow span. */
    note (kind: string, detail?: unknown): void {
        this.recorder?.note?.(kind, detail)
    }
}
