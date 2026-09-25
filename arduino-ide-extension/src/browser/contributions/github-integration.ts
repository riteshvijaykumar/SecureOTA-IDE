import { injectable } from 'inversify';
import * as fs from 'fs/promises';
import * as path from 'path';
import { GitHubApiClient, GitHubApiError } from '../../common/github/github-api-client';
import { ReleaseQueue } from '../../common/github/release-queue';
import type { GitHubSettings } from '../settings/github-settings';

export interface GitHubReleaseRecord {
  version: number;
  sketchName: string;
  repoName: string;
  timestamp: string;
  releaseId?: number;
  releaseUrl?: string;
  /** Set when the release could not be published and was queued for retry. */
  pending?: boolean;
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
  /** Board FQBN, recorded in the release notes when available. */
  fqbn?: string;
}

export interface GitHubIntegrationDeps {
  /** Current preference values; read per call so a settings change takes effect immediately. */
  readonly settings: () => GitHubSettings;
  /** Directory for the retry queue — normally the IDE's config dir. */
  readonly storageDir: string;
  /** Test seam. */
  readonly clientFactory?: (settings: GitHubSettings) => GitHubApiClient;
}

/**
 * MOD-04 — automated GitHub release pipeline.
 *
 * Invoked from UploadSketch after a successful flash. Publishing is best
 * effort by design: a flash that reached the board has already succeeded, so a
 * GitHub failure must never surface as an upload failure. Failures are queued
 * (see ReleaseQueue) and retried later.
 */
@injectable()
export class GitHubIntegration {
  private readonly versionFileName = '.secureota-version.json';
  private readonly queue: ReleaseQueue;

  constructor(private readonly deps: GitHubIntegrationDeps) {
    this.queue = new ReleaseQueue(deps.storageDir);
  }

  async triggerRelease(
    options: TriggerReleaseOptions
  ): Promise<GitHubReleaseRecord> {
    this.validateOptions(options);

    const settings = this.deps.settings();
    const state = await this.readVersionState(options.sketchPath);
    const nextVersion = state.currentVersion + 1;
    const repoName = state.repoName ?? this.normalizeRepoName(options.sketchName);

    const record: GitHubReleaseRecord = {
      version: nextVersion,
      sketchName: options.sketchName,
      repoName,
      timestamp: new Date().toISOString(),
    };

    // Integration is opt-in per design decision 3. When disabled the version
    // file is still advanced, so local history stays continuous and enabling
    // the integration later does not collide with tags already used.
    if (!settings.enabled) {
      return this.commitState(options.sketchPath, state, record, repoName);
    }

    try {
      const published = await this.publish(options, repoName, nextVersion, settings);
      record.releaseId = published.id;
      record.releaseUrl = published.htmlUrl;
    } catch (error) {
      record.pending = true;
      await this.queue.enqueue(
        { ...options, repoName, version: nextVersion },
        error
      );
    }

    return this.commitState(options.sketchPath, state, record, repoName);
  }

  /** Retry every queued release. Returns how many were published. */
  async drainQueue(): Promise<{ published: number; remaining: number }> {
    const settings = this.deps.settings();
    if (!settings.enabled) {
      return { published: 0, remaining: (await this.queue.list()).length };
    }

    let published = 0;
    for (const entry of await this.queue.list()) {
      try {
        const binPath = entry.binCopyPath;
        await this.publish(
          {
            sketchPath: entry.sketchPath,
            sketchName: entry.sketchName,
            binPath,
            devicePort: entry.devicePort,
          },
          entry.repoName,
          entry.version,
          settings
        );
        await this.queue.remove(entry.id);
        published++;
      } catch (error) {
        await this.queue.recordFailure(entry.id, error);
      }
    }

    return { published, remaining: (await this.queue.list()).length };
  }

  private async publish(
    options: TriggerReleaseOptions,
    repoName: string,
    version: number,
    settings: GitHubSettings
  ): Promise<{ id: number; htmlUrl: string }> {
    const client =
      this.deps.clientFactory?.(settings) ??
      new GitHubApiClient({
        token: settings.token,
        username: settings.username,
      });

    if (!(await client.repoExists(repoName))) {
      await client.createRepo(
        repoName,
        `Firmware history for Arduino sketch "${options.sketchName}", published by SecureOTA IDE.`
      );
    }

    const tag = `v${version}`;
    const sourceName = path.basename(options.sketchPath);
    const binName = `${repoName}-${tag}.bin`;

    const [source, binary] = await Promise.all([
      fs.readFile(options.sketchPath),
      fs.readFile(options.binPath),
    ]);

    await client.commitFile(
      repoName,
      sourceName,
      source,
      `SecureOTA IDE: source for ${tag}`
    );
    await client.commitFile(
      repoName,
      `firmware/${binName}`,
      binary,
      `SecureOTA IDE: firmware binary for ${tag}`
    );

    const release = await client.createRelease(
      repoName,
      tag,
      `${options.sketchName} ${tag}`,
      this.releaseNotes(options, version, binary.byteLength)
    );

    await client.uploadReleaseAsset(repoName, release.id, binName, binary);

    return { id: release.id, htmlUrl: release.htmlUrl };
  }

  /** MOD-04 remaining task 5: release notes carrying device and build info. */
  private releaseNotes(
    options: TriggerReleaseOptions,
    version: number,
    binaryBytes: number
  ): string {
    const lines = [
      `Automated release published by SecureOTA IDE.`,
      '',
      `- **Sketch:** ${options.sketchName}`,
      `- **Version:** v${version}`,
      `- **Firmware size:** ${binaryBytes.toLocaleString('en-US')} bytes`,
      `- **Flashed at:** ${new Date().toISOString()}`,
    ];
    if (options.fqbn) {
      lines.push(`- **Board:** ${options.fqbn}`);
    }
    if (options.devicePort) {
      lines.push(`- **Port:** ${options.devicePort}`);
    }
    return lines.join('\n');
  }

  private async commitState(
    sketchPath: string,
    state: GitHubVersionState,
    record: GitHubReleaseRecord,
    repoName: string
  ): Promise<GitHubReleaseRecord> {
    state.currentVersion = record.version;
    state.repoName = repoName;
    state.history.push(record);
    await this.writeVersionState(sketchPath, state);
    return record;
  }

  private validateOptions(options: TriggerReleaseOptions): void {
    for (const field of ['sketchPath', 'binPath', 'sketchName'] as const) {
      const value = options[field];
      if (!value || value.trim().length === 0) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
  }

  async readVersionState(sketchPath: string): Promise<GitHubVersionState> {
    const versionPath = this.resolveVersionFilePath(sketchPath);

    try {
      const raw = await fs.readFile(versionPath, 'utf8');
      const parsed = JSON.parse(raw) as GitHubVersionState;
      // A hand-edited or truncated file must not wedge every future flash, so
      // anything unusable degrades to a fresh state rather than throwing.
      return {
        currentVersion:
          Number.isSafeInteger(parsed?.currentVersion) && parsed.currentVersion >= 0
            ? parsed.currentVersion
            : 0,
        repoName: typeof parsed?.repoName === 'string' ? parsed.repoName : null,
        history: Array.isArray(parsed?.history) ? parsed.history : [],
      };
    } catch {
      return { currentVersion: 0, repoName: null, history: [] };
    }
  }

  private async writeVersionState(
    sketchPath: string,
    state: GitHubVersionState
  ): Promise<void> {
    const versionPath = this.resolveVersionFilePath(sketchPath);
    const temporary = `${versionPath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, versionPath);
  }

  private resolveVersionFilePath(sketchPath: string): string {
    return path.join(path.dirname(sketchPath), this.versionFileName);
  }

  private normalizeRepoName(sketchName: string): string {
    const normalized = sketchName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    // GitHub rejects an empty repository name; a sketch named only in a
    // non-Latin script would normalise to nothing.
    return normalized || 'secureota-sketch';
  }
}

export { GitHubApiError };
