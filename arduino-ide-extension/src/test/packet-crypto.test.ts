import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import {
  decodePacket,
  encodePacket,
  generateKeyHex,
  IV_BYTES,
  type TrackingPayload,
} from '../common/security/packet-crypto';

const aesKey = generateKeyHex();
const hmacSecret = generateKeyHex();

const payload: TrackingPayload = {
  mac: 'AA:BB:CC:DD:EE:FF',
  version: 'v3',
  sketch: 'BlinkLED',
  ip: '192.168.1.42',
  status: 'online',
  cnt: 7,
};

test('round-trips a well formed packet', () => {
  const result = decodePacket(encodePacket(payload, aesKey, hmacSecret), aesKey, hmacSecret);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.payload, payload);
});

test('rejects a packet encrypted with a different AES key', () => {
  const packet = encodePacket(payload, generateKeyHex(), hmacSecret);
  const result = decodePacket(packet, aesKey, hmacSecret);
  assert.equal(result.ok, false);
  // Wrong key almost always fails PKCS#7 padding; occasionally it decrypts to
  // garbage that still frames, which the HMAC then catches.
  assert.ok(
    !result.ok &&
      ['decrypt-failed', 'malformed-frame', 'hmac-mismatch'].includes(result.reason)
  );
});

test('rejects a packet signed with a different HMAC secret', () => {
  const packet = encodePacket(payload, aesKey, generateKeyHex());
  const result = decodePacket(packet, aesKey, hmacSecret);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'hmac-mismatch');
});

test('rejects a packet whose ciphertext has been tampered with', () => {
  const packet = encodePacket(payload, aesKey, hmacSecret);
  // Flip a bit well past the IV so the frame length stays valid.
  packet[packet.length - 20] ^= 0x01;
  const result = decodePacket(packet, aesKey, hmacSecret);
  assert.equal(result.ok, false);
});

test('rejects a truncated packet', () => {
  const result = decodePacket(Buffer.alloc(8), aesKey, hmacSecret);
  assert.equal(!result.ok && result.reason, 'packet-too-small');
});

test('rejects a packet whose body is not block aligned', () => {
  const packet = Buffer.concat([crypto.randomBytes(IV_BYTES), Buffer.alloc(17)]);
  const result = decodePacket(packet, aesKey, hmacSecret);
  assert.equal(!result.ok && result.reason, 'bad-block-alignment');
});

test('rejects a payload with a malformed MAC address', () => {
  const bad = { ...payload, mac: 'not-a-mac' };
  const result = decodePacket(
    encodePacket(bad as TrackingPayload, aesKey, hmacSecret),
    aesKey,
    hmacSecret
  );
  assert.equal(!result.ok && result.reason, 'missing-fields');
});

test('rejects a negative or non-integer counter', () => {
  for (const cnt of [-1, 1.5, Number.NaN]) {
    const result = decodePacket(
      encodePacket({ ...payload, cnt } as TrackingPayload, aesKey, hmacSecret),
      aesKey,
      hmacSecret
    );
    assert.equal(!result.ok && result.reason, 'missing-fields', `cnt=${cnt}`);
  }
});

test('tolerates a pipe character inside the sketch name', () => {
  // The frame splits on the LAST pipe, so a pipe in the JSON must not break it.
  const tricky = { ...payload, sketch: 'Blink|LED' };
  const result = decodePacket(encodePacket(tricky, aesKey, hmacSecret), aesKey, hmacSecret);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.payload.sketch, 'Blink|LED');
});

test('uppercases the MAC so registry lookups are case insensitive', () => {
  const lower = { ...payload, mac: 'aa:bb:cc:dd:ee:ff' };
  const result = decodePacket(encodePacket(lower, aesKey, hmacSecret), aesKey, hmacSecret);
  assert.equal(result.ok && result.payload.mac, 'AA:BB:CC:DD:EE:FF');
});

test('accepts a raw 32-character key as well as 64-char hex', () => {
  const raw = 'x'.repeat(32);
  const result = decodePacket(encodePacket(payload, raw, raw), raw, raw);
  assert.equal(result.ok, true);
});

test('a fresh IV is drawn per packet', () => {
  const first = encodePacket(payload, aesKey, hmacSecret);
  const second = encodePacket(payload, aesKey, hmacSecret);
  assert.notDeepEqual(first.subarray(0, IV_BYTES), second.subarray(0, IV_BYTES));
  // Identical plaintext must not produce identical ciphertext.
  assert.notDeepEqual(first, second);
});
