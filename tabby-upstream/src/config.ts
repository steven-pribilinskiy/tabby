import { ConfigProvider } from 'tabby-core'

/** @hidden */
export class UpstreamConfigProvider extends ConfigProvider {
    defaults = {
        upstream: {
            /** The checkout to report on. Empty means "find it from this build". */
            repositoryPath: '',
            /** The remote holding the project this fork tracks. */
            remote: 'upstream',
            /** The branch on it that `master` here mirrors. */
            branch: 'master',
        },
    }

    platformDefaults = { }
}
