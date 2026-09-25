import { ContainerModule } from 'inversify';
import * as os from 'os';
import * as path from 'path';
import { GitHubIntegration } from './contributions/github-integration';
import { DeviceRegistry } from '../common/security/device-registry';
import { DeviceListener } from '../common/devices/udp-listener';
import { defaultGitHubSettings, type GitHubSettings } from './settings/github-settings';

/**
 * Where per-installation state lives: the device registry and the pending
 * release queue. Overridable so tests and the Theia environment can redirect it.
 */
export const SECUREOTA_STORAGE_DIR =
  process.env.SECUREOTA_STORAGE_DIR ??
  path.join(os.homedir(), '.secureota-ide');

/**
 * Reads current preference values.
 *
 * Replaced at wiring time in the real IDE with a reader backed by Theia's
 * PreferenceService plus the keychain for the token; the default keeps the
 * module constructible standalone.
 */
export type SettingsReader = () => GitHubSettings;

export const defaultSettingsReader: SettingsReader = () => defaultGitHubSettings;

export function createSecureotaFrontendModule(
  settingsReader: SettingsReader = defaultSettingsReader,
  storageDir: string = SECUREOTA_STORAGE_DIR
): ContainerModule {
  return new ContainerModule((bind) => {
    // These carry constructor arguments, so they are bound by value rather
    // than with toSelf() — inversify cannot infer the storage directory.
    bind(DeviceRegistry)
      .toDynamicValue(() => new DeviceRegistry(storageDir))
      .inSingletonScope();

    bind(GitHubIntegration)
      .toDynamicValue(
        () =>
          new GitHubIntegration({
            settings: settingsReader,
            storageDir,
          })
      )
      .inSingletonScope();

    bind(DeviceListener)
      .toDynamicValue((context) => new DeviceListener(context.container.get(DeviceRegistry)))
      .inSingletonScope();
  });
}

/** Default module, for callers that do not need to override the wiring. */
export const secureotaFrontendModule = createSecureotaFrontendModule();
