import * as fs from 'fs/promises';
import * as path from 'path';
import type { TriggerReleaseOptions } from '../../browser/contributions/github-integration';

/**
 * Durable queue of releases that could not be published at flash time
 * (MOD-04 remaining task 2: "user has no internet during flash").
 *
 * A flash is not undone by a failed upload, so the release must be retried
 * rather than dropped. The queue is on disk because the common case is that
 * the user closes the IDE before connectivity returns.
 *
 * The compiled binary is copied into the queue directory at enqueue time. The
 * Arduino build directory is a temporary that is wiped between builds, so
 * retaining only its path would leave every queued entry pointing at nothing.
 */

export interface QueuedRelease {
  readonly id: string;
  readonly sketchPath: string;
  readonly sketchName: string;
  readonly repoName: string;
  readonly version: number;
  /** Path to the copy inside the queue directory, not the original build output. */
  readonly binCopyPath: string;
  readonly devicePort?: string;
  readonly queuedAt: string;
  readonly attempts: number;
  readonly lastError?: string;
}

interface QueueFile {
  version: 1;
  entries: QueuedRelease[];
}

export const QUEUE_FILE_NAME = 'pending-releases.json';
export const MAX_ATTEMPTS = 10;

export class ReleaseQueue {
  constructor(private readonly storageDir: string) {}

  private get filePath(): string {
    return path.join(this.storageDir, QUEUE_FILE_NAME);
  }

  private get binDir(): string {
    return path.join(this.storageDir, 'pending-bin');
  }

  private async read(): Promise<QueueFile> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as QueueFile;
      return Array.isArray(parsed?.entries)
        ? { version: 1, entries: parsed.entries }
        : { version: 1, entries: [] };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  private async write(queue: QueueFile): Promise<void> {
    await fs.mkdir(this.storageDir, { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.filePath);
  }

  async enqueue(
    options: TriggerReleaseOptions & { repoName: string; version: number },
    error: unknown
  ): Promise<QueuedRelease> {
    await fs.mkdir(this.binDir, { recursive: true });

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const binCopyPath = path.join(this.binDir, `${id}.bin`);
    await fs.copyFile(options.binPath, binCopyPath);

    const entry: QueuedRelease = {
      id,
      sketchPath: options.sketchPath,
      sketchName: options.sketchName,
      repoName: options.repoName,
      version: options.version,
      binCopyPath,
      devicePort: options.devicePort,
      queuedAt: new Date().toISOString(),
      attempts: 1,
      lastError: error instanceof Error ? error.message : String(error),
    };

    const queue = await this.read();
    queue.entries.push(entry);
    await this.write(queue);
    return entry;
  }

  async list(): Promise<QueuedRelease[]> {
    return (await this.read()).entries;
  }

  async remove(id: string): Promise<void> {
    const queue = await this.read();
    const entry = queue.entries.find((candidate) => candidate.id === id);
    queue.entries = queue.entries.filter((candidate) => candidate.id !== id);
    await this.write(queue);

    if (entry) {
      // Best effort: an orphaned binary wastes space but must not fail the
      // dequeue, which has already succeeded logically.
      await fs.rm(entry.binCopyPath, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Record a failed retry. Entries exceeding MAX_ATTEMPTS are dropped, so a
   * permanently broken entry — a revoked token, a deleted repo — cannot make
   * the queue grow without bound.
   */
  async recordFailure(id: string, error: unknown): Promise<'retained' | 'dropped'> {
    const queue = await this.read();
    const index = queue.entries.findIndex((candidate) => candidate.id === id);
    if (index < 0) {
      return 'dropped';
    }

    const entry = queue.entries[index];
    const attempts = entry.attempts + 1;

    if (attempts >= MAX_ATTEMPTS) {
      await this.remove(id);
      return 'dropped';
    }

    queue.entries[index] = {
      ...entry,
      attempts,
      lastError: error instanceof Error ? error.message : String(error),
    };
    await this.write(queue);
    return 'retained';
  }
}
