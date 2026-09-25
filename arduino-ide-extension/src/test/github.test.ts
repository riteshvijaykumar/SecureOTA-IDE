import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { GitHubApiClient, GitHubApiError } from '../common/github/github-api-client';
import { ReleaseQueue } from '../common/github/release-queue';
import { GitHubIntegration } from '../browser/contributions/github-integration';
import type { GitHubSettings } from '../browser/settings/github-settings';

interface StubCall {
  url: string;
  method: string;
}

/** Builds a fetch stub that replies from a scripted route table. */
function stubFetch(
  routes: Array<{ match: RegExp; method?: string; reply: () => Response }>
): { impl: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: href, method });

    for (const route of routes) {
      if (route.match.test(href) && (!route.method || route.method === method)) {
        return route.reply();
      }
    }
    return new Response('no route', { status: 500 });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secureota-gh-'));
});

test('client refuses to construct without credentials', () => {
  assert.throws(() => new GitHubApiClient({ token: '', username: 'u' }), /token is required/);
  assert.throws(() => new GitHubApiClient({ token: 't', username: '' }), /username is required/);
});

test('repoExists distinguishes 404 from success', async () => {
  const missing = stubFetch([{ match: /repos\/u\/absent/, reply: () => new Response('', { status: 404 }) }]);
  const present = stubFetch([{ match: /repos\/u\/present/, reply: () => json({ name: 'present' }) }]);

  assert.equal(
    await new GitHubApiClient({ token: 't', username: 'u', fetchImpl: missing.impl }).repoExists('absent'),
    false
  );
  assert.equal(
    await new GitHubApiClient({ token: 't', username: 'u', fetchImpl: present.impl }).repoExists('present'),
    true
  );
});

test('commitFile sends the blob sha when replacing an existing file', async () => {
  let sentBody: Record<string, unknown> | undefined;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return json({ sha: 'existing-sha' });
    }
    sentBody = JSON.parse(String(init?.body));
    return json({ content: {} }, 201);
  }) as unknown as typeof fetch;

  const client = new GitHubApiClient({ token: 't', username: 'u', fetchImpl: impl });
  await client.commitFile('repo', 'Blink.ino', Buffer.from('void setup(){}'), 'msg');

  assert.equal(sentBody?.sha, 'existing-sha');
  assert.equal(
    Buffer.from(String(sentBody?.content), 'base64').toString('utf8'),
    'void setup(){}'
  );
});

test('commitFile omits the sha when creating a new file', async () => {
  let sentBody: Record<string, unknown> | undefined;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response('', { status: 404 });
    }
    sentBody = JSON.parse(String(init?.body));
    return json({}, 201);
  }) as unknown as typeof fetch;

  await new GitHubApiClient({ token: 't', username: 'u', fetchImpl: impl }).commitFile(
    'repo',
    'New.ino',
    Buffer.from('x'),
    'msg'
  );

  assert.equal('sha' in (sentBody ?? {}), false);
});

test('client retries a secondary rate limit and then succeeds', async () => {
  let attempts = 0;
  const slept: number[] = [];
  const impl = (async () => {
    attempts++;
    if (attempts === 1) {
      return new Response('slow down', { status: 429, headers: { 'retry-after': '2' } });
    }
    return json({ id: 1, html_url: 'https://example/r', upload_url: 'https://example/u' }, 201);
  }) as unknown as typeof fetch;

  const client = new GitHubApiClient({
    token: 't',
    username: 'u',
    fetchImpl: impl,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });

  const release = await client.createRelease('repo', 'v1', 'name', 'body');
  assert.equal(release.id, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(slept, [2000]);
});

test('client honours a primary rate limit reset header', async () => {
  const slept: number[] = [];
  let attempts = 0;
  const resetAt = Math.floor((Date.now() + 30_000) / 1000);
  const impl = (async () => {
    attempts++;
    if (attempts === 1) {
      return new Response('limit', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) },
      });
    }
    return json({ id: 2, html_url: 'h', upload_url: 'u' }, 201);
  }) as unknown as typeof fetch;

  await new GitHubApiClient({
    token: 't',
    username: 'u',
    fetchImpl: impl,
    sleep: async (ms) => {
      slept.push(ms);
    },
  }).createRelease('r', 'v1', 'n', 'b');

  assert.equal(slept.length, 1);
  assert.ok(slept[0] > 25_000 && slept[0] <= 60_000, `slept ${slept[0]}ms`);
});

test('client does not retry a plain permission failure', async () => {
  let attempts = 0;
  const impl = (async () => {
    attempts++;
    return new Response('forbidden', { status: 403 });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () =>
      new GitHubApiClient({ token: 't', username: 'u', fetchImpl: impl, sleep: async () => {} })
        .createRelease('r', 'v1', 'n', 'b'),
    (error: unknown) => error instanceof GitHubApiError && error.retryable === false
  );
  assert.equal(attempts, 1, 'a 403 without rate-limit headers must not be retried');
});

// ── integration ───────────────────────────────────────────────────

async function sketchFixture(): Promise<{ sketchPath: string; binPath: string }> {
  const sketchDir = path.join(dir, 'BlinkLED');
  await fs.mkdir(sketchDir, { recursive: true });
  const sketchPath = path.join(sketchDir, 'BlinkLED.ino');
  const binPath = path.join(sketchDir, 'BlinkLED.bin');
  await fs.writeFile(sketchPath, 'void setup(){}\nvoid loop(){}\n');
  await fs.writeFile(binPath, Buffer.from([0xe9, 0x01, 0x02, 0x03]));
  return { sketchPath, binPath };
}

const enabled: GitHubSettings = { enabled: true, token: 't', username: 'u' };
const disabled: GitHubSettings = { enabled: false, token: '', username: '' };

test('disabled integration still advances local version history', async () => {
  const { sketchPath, binPath } = await sketchFixture();
  const integration = new GitHubIntegration({ settings: () => disabled, storageDir: dir });

  const first = await integration.triggerRelease({ sketchPath, binPath, sketchName: 'BlinkLED' });
  const second = await integration.triggerRelease({ sketchPath, binPath, sketchName: 'BlinkLED' });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(first.releaseId, undefined);

  const state = await integration.readVersionState(sketchPath);
  assert.equal(state.currentVersion, 2);
  assert.equal(state.history.length, 2);
});

test('a successful publish records the release id and url', async () => {
  const { sketchPath, binPath } = await sketchFixture();
  // 'BlinkLED' normalises to 'blinkled' — there is no separator to hyphenate —
  // so the routes match any repo name rather than pinning one.
  const stub = stubFetch([
    { match: /api\.github\.com\/repos\/u\/[^/]+$/, reply: () => json({ name: 'blinkled' }) },
    { match: /contents/, method: 'GET', reply: () => new Response('', { status: 404 }) },
    { match: /contents/, method: 'PUT', reply: () => json({}, 201) },
    {
      match: /releases$/,
      method: 'POST',
      reply: () => json({ id: 4242, html_url: 'https://github.com/u/blinkled/releases/tag/v1', upload_url: 'x' }, 201),
    },
    { match: /uploads\.github\.com/, reply: () => json({}, 201) },
  ]);

  const integration = new GitHubIntegration({
    settings: () => enabled,
    storageDir: dir,
    clientFactory: (settings) =>
      new GitHubApiClient({ token: settings.token, username: settings.username, fetchImpl: stub.impl }),
  });

  const record = await integration.triggerRelease({
    sketchPath,
    binPath,
    sketchName: 'BlinkLED',
    fqbn: 'esp32:esp32:esp32',
  });

  assert.equal(record.releaseId, 4242);
  assert.equal(record.pending, undefined);
  assert.ok(stub.calls.some((call) => /uploads\.github\.com/.test(call.url)), 'asset uploaded');
});

test('a repo that does not exist yet is created first', async () => {
  const { sketchPath, binPath } = await sketchFixture();
  const stub = stubFetch([
    { match: /user\/repos/, method: 'POST', reply: () => json({}, 201) },
    { match: /api\.github\.com\/repos\/u\/[^/]+$/, method: 'GET', reply: () => new Response('', { status: 404 }) },
    { match: /contents/, method: 'GET', reply: () => new Response('', { status: 404 }) },
    { match: /contents/, method: 'PUT', reply: () => json({}, 201) },
    { match: /releases$/, method: 'POST', reply: () => json({ id: 1, html_url: 'h', upload_url: 'u' }, 201) },
    { match: /uploads\.github\.com/, reply: () => json({}, 201) },
  ]);

  await new GitHubIntegration({
    settings: () => enabled,
    storageDir: dir,
    clientFactory: (s) => new GitHubApiClient({ token: s.token, username: s.username, fetchImpl: stub.impl }),
  }).triggerRelease({ sketchPath, binPath, sketchName: 'BlinkLED' });

  assert.ok(stub.calls.some((call) => /user\/repos/.test(call.url) && call.method === 'POST'));
});

test('a failed publish queues the release instead of failing the flash', async () => {
  const { sketchPath, binPath } = await sketchFixture();
  const offline = (async () => {
    throw new Error('getaddrinfo ENOTFOUND api.github.com');
  }) as unknown as typeof fetch;

  const integration = new GitHubIntegration({
    settings: () => enabled,
    storageDir: dir,
    clientFactory: (s) => new GitHubApiClient({ token: s.token, username: s.username, fetchImpl: offline }),
  });

  const record = await integration.triggerRelease({ sketchPath, binPath, sketchName: 'BlinkLED' });

  assert.equal(record.pending, true, 'the flash succeeded, so the release is queued not lost');
  assert.equal(record.version, 1);

  const queued = await new ReleaseQueue(dir).list();
  assert.equal(queued.length, 1);
  // The build directory is transient, so the binary must have been copied.
  await assert.doesNotReject(() => fs.access(queued[0].binCopyPath));
});

test('drainQueue publishes a queued release and empties the queue', async () => {
  const { sketchPath, binPath } = await sketchFixture();
  let online = false;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!online) {
      throw new Error('offline');
    }
    const href = String(url);
    const method = init?.method ?? 'GET';
    if (/uploads\.github\.com/.test(href)) return json({}, 201);
    if (/releases$/.test(href) && method === 'POST') return json({ id: 9, html_url: 'h', upload_url: 'u' }, 201);
    if (/contents/.test(href)) return method === 'GET' ? new Response('', { status: 404 }) : json({}, 201);
    return json({ name: 'blink-led' });
  }) as unknown as typeof fetch;

  const integration = new GitHubIntegration({
    settings: () => enabled,
    storageDir: dir,
    clientFactory: (s) => new GitHubApiClient({ token: s.token, username: s.username, fetchImpl: impl }),
  });

  await integration.triggerRelease({ sketchPath, binPath, sketchName: 'BlinkLED' });
  assert.equal((await new ReleaseQueue(dir).list()).length, 1);

  online = true;
  const result = await integration.drainQueue();

  assert.equal(result.published, 1);
  assert.equal(result.remaining, 0);
});

test('a sketch name with no Latin characters still yields a valid repo name', async () => {
  const sketchDir = path.join(dir, 'unicode');
  await fs.mkdir(sketchDir, { recursive: true });
  const sketchPath = path.join(sketchDir, 'x.ino');
  const binPath = path.join(sketchDir, 'x.bin');
  await fs.writeFile(sketchPath, 'x');
  await fs.writeFile(binPath, 'x');

  const record = await new GitHubIntegration({
    settings: () => disabled,
    storageDir: dir,
  }).triggerRelease({ sketchPath, binPath, sketchName: 'नमस्ते' });

  assert.equal(record.repoName, 'secureota-sketch');
});

test('triggerRelease rejects incomplete options', async () => {
  const integration = new GitHubIntegration({ settings: () => disabled, storageDir: dir });
  await assert.rejects(
    () => integration.triggerRelease({ sketchPath: '', binPath: 'b', sketchName: 's' }),
    /Missing required field: sketchPath/
  );
});
