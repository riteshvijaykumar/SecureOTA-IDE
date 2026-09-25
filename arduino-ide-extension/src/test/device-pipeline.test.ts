import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DeviceRegistry } from '../common/security/device-registry';
import { DeviceListener } from '../common/devices/udp-listener';
import { encodePacket, type TrackingPayload } from '../common/security/packet-crypto';
import { assessRelevance } from '../common/devices/relevance';

const MAC = 'AA:BB:CC:DD:EE:FF';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'secureota-test-'));
}

function payload(overrides: Partial<TrackingPayload> = {}): TrackingPayload {
  return {
    mac: MAC,
    version: 'v1',
    sketch: 'BlinkLED',
    ip: '192.168.1.10',
    status: 'online',
    cnt: 1,
    ...overrides,
  };
}

let dir: string;
let registry: DeviceRegistry;

beforeEach(async () => {
  dir = await tempDir();
  registry = new DeviceRegistry(dir);
});

test('provision mints distinct per-device keys', async () => {
  const first = await registry.provision(MAC, 'BlinkLED');
  const second = await registry.provision('11:22:33:44:55:66', 'Other');

  assert.notEqual(first.aesKey, second.aesKey);
  assert.notEqual(first.hmacSecret, second.hmacSecret);
  assert.equal(first.aesKey.length, 64);
});

test('re-provisioning keeps keys but resets the counter', async () => {
  const original = await registry.provision(MAC, 'BlinkLED');
  await registry.accept(MAC, 5, {});

  const reflashed = await registry.provision(MAC, 'BlinkLED v2');

  assert.equal(reflashed.aesKey, original.aesKey);
  assert.equal(reflashed.lastCounter, 0, 'a reflashed device restarts its NVS counter');
});

test('registry survives a reload from disk', async () => {
  const provisioned = await registry.provision(MAC, 'BlinkLED');
  const reloaded = new DeviceRegistry(dir);
  const found = await reloaded.get(MAC.toLowerCase());

  assert.equal(found?.aesKey, provisioned.aesKey);
});

test('accept advances only on a strictly greater counter', async () => {
  await registry.provision(MAC, 'BlinkLED');

  assert.equal(await registry.accept(MAC, 5, {}), true);
  assert.equal(await registry.accept(MAC, 5, {}), false, 'replay of the same counter');
  assert.equal(await registry.accept(MAC, 4, {}), false, 'replay of an older counter');
  assert.equal(await registry.accept(MAC, 6, {}), true);
});

test('accept rejects an unregistered device', async () => {
  assert.equal(await registry.accept('00:00:00:00:00:01', 1, {}), false);
});

test('a corrupted registry file degrades to empty rather than throwing', async () => {
  await fs.writeFile(path.join(dir, 'device-registry.json'), '{ not json', 'utf8');
  assert.deepEqual(await new DeviceRegistry(dir).list(), []);
});

// ── the four-layer pipeline ───────────────────────────────────────

test('listener accepts a valid packet from a registered device', async () => {
  const record = await registry.provision(MAC, 'BlinkLED');
  const listener = new DeviceListener(registry);

  const accepted = await listener.handlePacket(
    encodePacket(payload(), record.aesKey, record.hmacSecret),
    '192.168.1.10'
  );

  assert.equal(accepted, true);
  assert.equal(listener.statistics().accepted, 1);
  assert.equal(listener.devices()[0].mac, MAC);
});

test('listener drops a replayed packet (layer 4)', async () => {
  const record = await registry.provision(MAC, 'BlinkLED');
  const listener = new DeviceListener(registry);
  const packet = encodePacket(payload({ cnt: 3 }), record.aesKey, record.hmacSecret);

  assert.equal(await listener.handlePacket(packet, '1.1.1.1'), true);
  assert.equal(await listener.handlePacket(packet, '1.1.1.1'), false);
  assert.equal(listener.statistics().rejected['replayed-counter'], 1);
});

test('listener drops a packet from an unregistered device (layer 3)', async () => {
  await registry.provision(MAC, 'BlinkLED');
  const listener = new DeviceListener(registry);

  // Valid structure, but signed with keys no registered device holds.
  const stranger = encodePacket(
    payload({ mac: '99:99:99:99:99:99' }),
    'a'.repeat(32),
    'b'.repeat(32)
  );

  assert.equal(await listener.handlePacket(stranger, '1.1.1.1'), false);
  assert.equal(listener.statistics().accepted, 0);
});

test('listener drops a device impersonating another registered MAC', async () => {
  const victim = await registry.provision(MAC, 'BlinkLED');
  await registry.provision('11:22:33:44:55:66', 'Other');
  const listener = new DeviceListener(registry);

  // Signed with the victim's keys but claiming a different MAC.
  const forged = encodePacket(
    payload({ mac: '11:22:33:44:55:66' }),
    victim.aesKey,
    victim.hmacSecret
  );

  assert.equal(await listener.handlePacket(forged, '1.1.1.1'), false);
  assert.equal(listener.statistics().rejected['unknown-device'], 1);
});

test('listener drops a tampered packet (layer 2)', async () => {
  const record = await registry.provision(MAC, 'BlinkLED');
  const listener = new DeviceListener(registry);
  const packet = encodePacket(payload(), record.aesKey, record.hmacSecret);
  packet[packet.length - 20] ^= 0xff;

  assert.equal(await listener.handlePacket(packet, '1.1.1.1'), false);
  assert.equal(listener.statistics().accepted, 0);
});

test('listener marks a device offline once its last packet is stale', async () => {
  const record = await registry.provision(MAC, 'BlinkLED');
  const listener = new DeviceListener(registry);
  await listener.handlePacket(
    encodePacket(payload(), record.aesKey, record.hmacSecret),
    '1.1.1.1'
  );

  assert.equal(listener.devices()[0].online, true);
  assert.equal(listener.devices(Date.now() + 120_000)[0].online, false);
});

// ── MOD-06 ────────────────────────────────────────────────────────

test('relevance scores the covered fraction of the device profile', () => {
  const result = assessRelevance(['esp32', 'wifi', 'led'], ['esp32', 'wifi', 'bluetooth', 'sensor']);
  assert.equal(result.score, 0.5);
  assert.equal(result.verdict, 'proceed');
  assert.deepEqual(result.matched, ['esp32', 'wifi']);
  assert.deepEqual(result.missing, ['bluetooth', 'sensor']);
});

test('relevance warns below the threshold and strongly warns at zero', () => {
  // 1/3 = 0.33, at or above the 0.3 threshold.
  assert.equal(assessRelevance(['led'], ['a', 'b', 'led']).verdict, 'proceed');
  // 1/4 = 0.25, below it.
  assert.equal(assessRelevance(['led'], ['a', 'b', 'c', 'led']).verdict, 'warn');
  // Nothing in common at all.
  assert.equal(assessRelevance(['led'], ['esp32', 'wifi']).verdict, 'strong-warning');
});

test('relevance does not object when the device profile is unknown', () => {
  const result = assessRelevance(['anything'], []);
  assert.equal(result.verdict, 'proceed');
  assert.equal(result.score, 1);
});

test('relevance ignores case and surrounding whitespace', () => {
  assert.equal(assessRelevance([' ESP32 '], ['esp32']).score, 1);
});
