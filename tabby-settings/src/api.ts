/**
 * Extend to add your own settings tabs
 */
export abstract class SettingsTabProvider {
    id: string
    icon: string
    title: string
    weight = 0
    prioritized = false
    /**
     * Drop the 600px reading-width cap for this tab. For a settings form that
     * cap is the point; for a tab that shows data — a table, a wide list — it
     * just throws the width away.
     */
    wide = false

    getComponentType (): any {
        return null
    }
}
