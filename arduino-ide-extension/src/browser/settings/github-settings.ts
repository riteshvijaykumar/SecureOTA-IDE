export interface GitHubSettings {
  enabled: boolean;
  token: string;
  username: string;
}

export const defaultGitHubSettings: GitHubSettings = {
  enabled: false,
  token: '',
  username: ''
};
