import { BaseTabComponent } from '../components/baseTab.component'
import { NewTabParameters } from '../services/tabs.service'
import { RecoveryToken } from './tabRecovery'

/**
 * Extend to add your own data to every tab's recovery token, and to act on it
 * when the tab comes back.
 *
 * [[TabRecoveryProvider]] answers "which tab type is this token, and how do I
 * build it" — one provider per tab type, and the first applicable one wins. An
 * augmentor is the other axis: it runs for *every* token regardless of type, so
 * a plugin can persist something about a tab without owning that tab's type or
 * editing the provider that does.
 *
 * The two halves are deliberately symmetric. [[augment]] adds to a token on its
 * way to storage; [[restore]] reads it back and adjusts the parameters the tab
 * is about to be built from — including inputs the tab type never declared,
 * since [[TabsService.create]] assigns them onto the component.
 *
 * Both are awaited, and both run for every token that is saved or recovered, so
 * neither should do anything expensive. Read a cache; do not fill one.
 */
export abstract class TabRecoveryAugmentor {
    /**
     * Add to a tab's token just before it is persisted.
     *
     * `options.includeState` distinguishes the persistence pass from the
     * cheaper token taken to duplicate a tab or hand it to another window —
     * anything that should not follow a duplicate belongs behind it.
     */
    async augment (tab: BaseTabComponent, token: RecoveryToken, options?: { includeState?: boolean }): Promise<void> { } // eslint-disable-line

    /**
     * Act on a token that has just produced tab parameters, before the tab is
     * created from them.
     */
    async restore (token: RecoveryToken, params: NewTabParameters<BaseTabComponent>): Promise<void> { } // eslint-disable-line
}
