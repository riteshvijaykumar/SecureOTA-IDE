import { injectable } from 'inversify';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface GitHubReleaseRecord {
  version: number;
  sketchName: string;
  repoName: string;
  timestamp: string;
  releaseId?: number;
  releaseUrl?: string;
}

export interface GitHubVersionState {
  currentVersion: number;
  repoName: string | null;
  history: GitHubReleaseRecord[];
}

export interface TriggerReleaseOptions {
  sketchPath: string;
  binPath: string;
  sketchName: string;
  devicePort?: string;
}

@injectable()
export class GitHubIntegration {
  private readonly versionFileName = '.secureota-version.json';

  async triggerRelease(options: TriggerReleaseOptions): Promise<GitHubReleaseRecord> {
    this.validateOptions(options);

    const state = await this.readVersionState(options.sketchPath);
    const nextVersion = state.currentVersion + 1;
    const repoName = state.repoName ?? this.normalizeRepoName(options.sketchName);

    const record: GitHubReleaseRecord = {
      version: nextVersion,
      sketchName: options.sketchName,
      repoName,
      timestamp: new Date().toISOString()
    };

    state.currentVersion = nextVersion;
    state.repoName = repoName;
    state.history.push(record);

    await this.writeVersionState(options.sketchPath, state);
    return record;
  }

  private validateOptions(options: TriggerReleaseOptions): void {
    for (const field of ['sketchPath', 'binPath', 'sketchName'] as const) {
      if (!options[field] || options[field].trim().length === 0) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
  }

  private async readVersionState(sketchPath: string): Promise<GitHubVersionState> {
    const versionPath = this.resolveVersionFilePath(sketchPath);

    try {
      const raw = await fs.readFile(versionPath, 'utf8');
      return JSON.parse(raw) as GitHubVersionState;
    } catch {
      return {
        currentVersion: 0,
        repoName: null,
        history: []
      };
    }
  }

  private async writeVersionState(sketchPath: string, state: GitHubVersionState): Promise<void> {
    const versionPath = this.resolveVersionFilePath(sketchPath);
    await fs.writeFile(versionPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  private resolveVersionFilePath(sketchPath: string): string {
    return path.join(path.dirname(sketchPath), this.versionFileName);
  }

  private normalizeRepoName(sketchName: string): string {
    return sketchName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
}
