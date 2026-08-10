/** Display helpers. Kept out of the component so the table and the cards agree. */

export function humanBytes (bytes: number | null | undefined): string {
    if (bytes === null || bytes === undefined) {
        return '—'
    }
    if (bytes < 1024) {
        return `${bytes} B`
    }
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = bytes / 1024
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit++
    }
    return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/** "3 min", "14 h", "6 d" — compact enough for a table cell. */
export function humanDuration (ms: number | null | undefined): string {
    if (ms === null || ms === undefined) {
        return '—'
    }
    const seconds = Math.max(0, Math.round(ms / 1000))
    if (seconds < 60) {
        return `${seconds} s`
    }
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) {
        return `${minutes} min`
    }
    const hours = Math.floor(minutes / 60)
    if (hours < 48) {
        const rest = minutes % 60
        return rest && hours < 10 ? `${hours} h ${rest} min` : `${hours} h`
    }
    return `${Math.round(hours / 24)} d`
}

export function humanAgo (timestamp: number | null | undefined): string {
    if (!timestamp) {
        return '—'
    }
    return `${humanDuration(Date.now() - timestamp)} ago`
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local time deliberately: this is read by the person sitting at the machine. */
export function absoluteTime (timestamp: number | null | undefined): string {
    if (!timestamp) {
        return '—'
    }
    const d = new Date(timestamp)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Middle-ellipsize a path so both the root and the leaf stay readable. */
export function shortPath (p: string, max = 64): string {
    if (p.length <= max) {
        return p
    }
    const keepEnd = Math.floor(max * 0.6)
    const keepStart = max - keepEnd - 1
    return `${p.slice(0, keepStart)}…${p.slice(-keepEnd)}`
}
