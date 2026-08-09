/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, Inject, Optional } from '@angular/core'
import { LocalProfile, UACService } from '../api'
import { FullyDefined, PlatformService, ProfileSettingsComponent, NotificationsService, TranslateService } from 'tabby-core'
import { LocalProfilesService } from '../profiles'
import { WSLDirectoryPickerService } from '../services/wslDirectoryPicker.service'


/** @hidden */
@Component({
    templateUrl: './localProfileSettings.component.pug',
})
export class LocalProfileSettingsComponent implements ProfileSettingsComponent<LocalProfile, LocalProfilesService> {
    profile: FullyDefined<LocalProfile>

    constructor (
        @Optional() @Inject(UACService) public uac: UACService|undefined,
        private platform: PlatformService,
        private wslPicker: WSLDirectoryPickerService,
        private notifications: NotificationsService,
        private translate: TranslateService,
    ) { }

    async pickWorkingDirectory (): Promise<void> {
        // A WSL profile runs inside the distro, so the Windows folder dialog
        // would hand it a path it cannot cd into. Browse the distro instead.
        const distro = this.wslPicker.getDistro(this.profile.options.command, this.profile.options.args)
        if (distro !== null) {
            if (!await this.wslPicker.isRunning(distro)) {
                this.notifications.error(this.translate.instant(
                    'Start the WSL distribution first to browse its directories',
                ))
                return
            }
            const picked = await this.wslPicker.pick(distro, this.profile.options.cwd)
            if (picked) {
                this.profile.options.cwd = picked
            }
            return
        }

        const cwd = await this.platform.pickDirectory()
        if (!cwd) {
            return
        }
        this.profile.options.cwd = cwd
    }
}
