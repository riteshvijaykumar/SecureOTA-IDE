/**
 * Minimal GitHub REST v3 client covering exactly the calls MOD-04 needs.
 *
 * Written against the built-in `fetch` rather than pulling in Octokit: the six
 * endpoints below are the entire surface this project uses, and Octokit would
 * add a large dependency tree to an Electron bundle for no benefit.
 */

export const GITHUB_API_ROOT = 'https://api.github.com';
export const GITHUB_UPLOAD_ROOT = 'https://uploads.github.com';

export interface GitHubClientOptions {
  readonly token: string;
  readonly username: string;
  readonly apiRoot?: string;
  readonly uploadRoot?: string;
  readonly fetchImpl?: typeof fetch;
  /** Attempts per request when GitHub reports a retryable condition. */
  readonly maxAttempts?: number;
  /** Test seam; real sleeps make the retry tests take minutes. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ReleaseRef {
  readonly id: number;
  readonly htmlUrl: string;
  readonly uploadUrl: string;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    /** True when the caller may usefully retry later (rate limit, 5xx). */
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class GitHubApiClient {
  private readonly token: string;
  private readonly apiRoot: string;
  private readonly uploadRoot: string;
  private readonly doFetch: typeof fetch;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  readonly username: string;

  constructor(options: GitHubClientOptions) {
    if (!options.token) {
      throw new Error('A GitHub token is required.');
    }
    if (!options.username) {
      throw new Error('A GitHub username is required.');
    }
    this.token = options.token;
    this.username = options.username;
    this.apiRoot = options.apiRoot ?? GITHUB_API_ROOT;
    this.uploadRoot = options.uploadRoot ?? GITHUB_UPLOAD_ROOT;
    this.doFetch = options.fetchImpl ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep = options.sleep ?? defaultSleep;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'SecureOTA-IDE',
      ...extra,
    };
  }

  /**
   * Issue a request, retrying on rate limit and 5xx.
   *
   * GitHub signals a primary rate limit as 403 with `x-ratelimit-remaining: 0`
   * and a reset timestamp, and a secondary limit as 403/429 with `retry-after`.
   * Both are honoured; a 403 that is neither is a genuine permission failure
   * and is not retried, since retrying it just burns the remaining quota.
   */
  private async request(
    url: string,
    init: RequestInit,
    endpoint: string
  ): Promise<Response> {
    let lastError: GitHubApiError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const response = await this.doFetch(url, init);

      if (response.ok) {
        return response;
      }

      const retryAfter = this.retryDelayMs(response);
      const retryable = retryAfter !== undefined;

      lastError = new GitHubApiError(
        `${endpoint} failed: ${response.status} ${response.statusText}`,
        response.status,
        endpoint,
        retryable
      );

      if (!retryable || attempt === this.maxAttempts) {
        throw lastError;
      }
      await this.sleep(retryAfter);
    }

    throw lastError ?? new GitHubApiError(`${endpoint} failed`, 0, endpoint, false);
  }

  /** Milliseconds to wait, or undefined when the response is not retryable. */
  private retryDelayMs(response: Response): number | undefined {
    if (response.status >= 500) {
      return 1000;
    }

    if (response.status === 403 || response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) {
          return Math.max(0, seconds * 1000);
        }
      }

      if (response.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(response.headers.get('x-ratelimit-reset'));
        if (Number.isFinite(reset)) {
          // Header is epoch seconds; clamp so a skewed clock cannot make the
          // IDE sleep for hours after a flash.
          const deltaMs = reset * 1000 - Date.now();
          return Math.min(Math.max(deltaMs, 0), 60_000);
        }
        return 60_000;
      }
    }

    return undefined;
  }

  async repoExists(repo: string): Promise<boolean> {
    const response = await this.doFetch(
      `${this.apiRoot}/repos/${this.username}/${repo}`,
      { method: 'GET', headers: this.headers() }
    );
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new GitHubApiError(
        `repoExists failed: ${response.status} ${response.statusText}`,
        response.status,
        'GET /repos',
        response.status >= 500
      );
    }
    return true;
  }

  async createRepo(repo: string, description: string): Promise<void> {
    await this.request(
      `${this.apiRoot}/user/repos`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          name: repo,
          description,
          private: true,
          auto_init: true,
        }),
      },
      'POST /user/repos'
    );
  }

  /** Existing blob SHA for a path, or undefined when the file is new. */
  async fileSha(repo: string, filePath: string): Promise<string | undefined> {
    const response = await this.doFetch(
      `${this.apiRoot}/repos/${this.username}/${repo}/contents/${encodeURI(filePath)}`,
      { method: 'GET', headers: this.headers() }
    );
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as { sha?: string };
    return body.sha;
  }

  /**
   * Create or update a file. The blob SHA is required by the API when
   * replacing an existing file and must be absent when creating one, so it is
   * looked up rather than assumed.
   */
  async commitFile(
    repo: string,
    filePath: string,
    contents: Buffer,
    message: string
  ): Promise<void> {
    const sha = await this.fileSha(repo, filePath);
    await this.request(
      `${this.apiRoot}/repos/${this.username}/${repo}/contents/${encodeURI(filePath)}`,
      {
        method: 'PUT',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          message,
          content: contents.toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      },
      'PUT /repos/contents'
    );
  }

  async createRelease(
    repo: string,
    tag: string,
    name: string,
    body: string
  ): Promise<ReleaseRef> {
    const response = await this.request(
      `${this.apiRoot}/repos/${this.username}/${repo}/releases`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tag_name: tag, name, body }),
      },
      'POST /repos/releases'
    );

    const json = (await response.json()) as {
      id: number;
      html_url: string;
      upload_url: string;
    };

    return {
      id: json.id,
      htmlUrl: json.html_url,
      uploadUrl: json.upload_url,
    };
  }

  async uploadReleaseAsset(
    repo: string,
    releaseId: number,
    assetName: string,
    contents: Buffer
  ): Promise<void> {
    const url =
      `${this.uploadRoot}/repos/${this.username}/${repo}/releases/${releaseId}/assets` +
      `?name=${encodeURIComponent(assetName)}`;

    await this.request(
      url,
      {
        method: 'POST',
        headers: this.headers({
          'content-type': 'application/octet-stream',
          'content-length': String(contents.byteLength),
        }),
        body: new Uint8Array(contents),
      },
      'POST /releases/assets'
    );
  }
}
