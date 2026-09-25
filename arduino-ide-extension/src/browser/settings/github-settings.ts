/**
 * MOD-04 remaining task 1 — preferences schema for the GitHub integration.
 *
 * The token is deliberately NOT stored here in production. `defaultGitHubSettings`
 * carries an empty string and the real value is read from the Arduino IDE
 * keychain (see `.scripts/store-pat.js`, credentials section `secureota.github`).
 * Theia preference values land in a plaintext settings.json, which is not an
 * acceptable home for a credential that can create repositories.
 */

export interface GitHubSettings {
  enabled: boolean;
  token: string;
  username: string;
}

export const defaultGitHubSettings: GitHubSettings = {
  enabled: false,
  token: '',
  username: '',
};

export const GITHUB_PREFERENCE_IDS = {
  enabled: 'secureota.github.enabled',
  username: 'secureota.github.username',
} as const;

/**
 * Theia preference schema fragment. Register from the frontend module with
 * `PreferenceContribution`.
 *
 * There is no `secureota.github.token` property: exposing a preference for it
 * would put the token in settings.json. The IDE prompts for it once and stores
 * it in the keychain instead.
 */
export const gitHubPreferenceSchema = {
  type: 'object',
  properties: {
    [GITHUB_PREFERENCE_IDS.enabled]: {
      type: 'boolean',
      default: false,
      description:
        'Publish a GitHub release automatically after each successful upload.',
    },
    [GITHUB_PREFERENCE_IDS.username]: {
      type: 'string',
      default: '',
      description: 'GitHub account that owns the sketch repositories.',
    },
  },
} as const;

export function isConfigured(settings: GitHubSettings): boolean {
  return (
    settings.enabled &&
    settings.token.trim().length > 0 &&
    settings.username.trim().length > 0
  );
}
