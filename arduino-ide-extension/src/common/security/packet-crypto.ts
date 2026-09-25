import * as crypto from 'crypto';

/**
 * Packet cryptography for the Live Device Panel (MOD-07).
 *
 * Wire format of a tracking packet, as broadcast by the ESP32 agent:
 *
 *     ┌──────────────┬────────────────────────────────────┐
 *     │  IV, 16 B    │  AES-256-CBC ciphertext, N × 16 B  │
 *     └──────────────┴────────────────────────────────────┘
 *
 * The plaintext inside the ciphertext is `<json>|<hmac-hex>`, the HMAC being
 * computed over the JSON alone. This is sign-then-encrypt, per the project's
 * design decision 6.
 *
 * Note on the IV: the design notes describe a "128-bit IV, randomised per
 * session" but the sketched packet layout omitted it. A CBC ciphertext cannot
 * be decrypted without its IV, so it is transmitted as the first 16 bytes of
 * every packet. Randomising per packet rather than per session is strictly
 * stronger and costs nothing, so the agent draws a fresh IV each broadcast.
 */

export const IV_BYTES = 16;
export const AES_BLOCK_BYTES = 16;
export const HMAC_HEX_CHARS = 64;
export const KEY_BYTES = 32;

/** Smallest packet that could possibly be well formed: IV + one cipher block. */
export const MIN_PACKET_BYTES = IV_BYTES + AES_BLOCK_BYTES;

export interface TrackingPayload {
  readonly mac: string;
  readonly version: string;
  readonly sketch: string;
  readonly ip: string;
  readonly status: string;
  readonly cnt: number;
}

export type DecodeFailure =
  | 'packet-too-small'
  | 'bad-block-alignment'
  | 'decrypt-failed'
  | 'malformed-frame'
  | 'hmac-mismatch'
  | 'malformed-json'
  | 'missing-fields';

export type DecodeResult =
  | { readonly ok: true; readonly payload: TrackingPayload }
  | { readonly ok: false; readonly reason: DecodeFailure };

function normalizeKey(key: string | Buffer, label: string): Buffer {
  const buffer =
    typeof key === 'string'
      ? // A 64-char hex string and a 32-char raw string are both 256 bits; the
        // agent injects whichever the preprocessing step produced.
        /^[0-9a-fA-F]{64}$/.test(key)
        ? Buffer.from(key, 'hex')
        : Buffer.from(key, 'utf8')
      : key;

  if (buffer.length !== KEY_BYTES) {
    throw new Error(
      `${label} must be ${KEY_BYTES} bytes (got ${buffer.length}).`
    );
  }
  return buffer;
}

/**
 * Layer 1 + Layer 2: decrypt the packet and verify its HMAC.
 *
 * Returns a discriminated result rather than throwing, because this runs once
 * per received datagram on an open UDP port — malformed and hostile input is
 * the expected case, not an exceptional one, and a throw per packet would be
 * both slow and easy to turn into a denial of service.
 */
export function decodePacket(
  packet: Buffer,
  aesKey: string | Buffer,
  hmacSecret: string | Buffer
): DecodeResult {
  if (packet.length < MIN_PACKET_BYTES) {
    return { ok: false, reason: 'packet-too-small' };
  }

  const body = packet.subarray(IV_BYTES);
  if (body.length % AES_BLOCK_BYTES !== 0) {
    return { ok: false, reason: 'bad-block-alignment' };
  }

  let plaintext: string;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      normalizeKey(aesKey, 'AES key'),
      packet.subarray(0, IV_BYTES)
    );
    plaintext = Buffer.concat([
      decipher.update(body),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong key, or corrupted/forged ciphertext failing the padding check.
    return { ok: false, reason: 'decrypt-failed' };
  }

  // Split on the LAST separator: the JSON may legitimately contain '|' inside
  // a sketch name, but the HMAC suffix is fixed-width hex and always trails.
  const separator = plaintext.lastIndexOf('|');
  if (separator <= 0) {
    return { ok: false, reason: 'malformed-frame' };
  }

  const json = plaintext.slice(0, separator);
  const receivedHmac = plaintext.slice(separator + 1).trim();
  if (!/^[0-9a-f]{64}$/i.test(receivedHmac)) {
    return { ok: false, reason: 'malformed-frame' };
  }

  const expectedHmac = crypto
    .createHmac('sha256', normalizeKey(hmacSecret, 'HMAC secret'))
    .update(json, 'utf8')
    .digest();

  const received = Buffer.from(receivedHmac, 'hex');
  // Constant-time comparison. A plain `!==` on hex strings leaks, through its
  // timing, how many leading bytes an attacker guessed correctly, which turns
  // forging a valid HMAC into a byte-at-a-time search.
  if (
    received.length !== expectedHmac.length ||
    !crypto.timingSafeEqual(received, expectedHmac)
  ) {
    return { ok: false, reason: 'hmac-mismatch' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'malformed-json' };
  }

  const payload = coercePayload(parsed);
  if (!payload) {
    return { ok: false, reason: 'missing-fields' };
  }

  return { ok: true, payload };
}

function coercePayload(value: unknown): TrackingPayload | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;

  const mac = typeof record.mac === 'string' ? record.mac.toUpperCase() : '';
  const cnt = typeof record.cnt === 'number' ? record.cnt : NaN;

  if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
    return undefined;
  }
  if (!Number.isSafeInteger(cnt) || cnt < 0) {
    return undefined;
  }

  return {
    mac,
    cnt,
    version: typeof record.version === 'string' ? record.version : '',
    sketch: typeof record.sketch === 'string' ? record.sketch : '',
    ip: typeof record.ip === 'string' ? record.ip : '',
    status: typeof record.status === 'string' ? record.status : 'unknown',
  };
}

/**
 * Encode a packet exactly as the ESP32 agent does.
 *
 * Present so the verification path can be tested end to end against bytes
 * produced by an independent implementation of the same format, and so the
 * format stays executable documentation for the C++ side.
 */
export function encodePacket(
  payload: TrackingPayload,
  aesKey: string | Buffer,
  hmacSecret: string | Buffer,
  iv: Buffer = crypto.randomBytes(IV_BYTES)
): Buffer {
  if (iv.length !== IV_BYTES) {
    throw new Error(`IV must be ${IV_BYTES} bytes (got ${iv.length}).`);
  }

  const json = JSON.stringify(payload);
  const hmac = crypto
    .createHmac('sha256', normalizeKey(hmacSecret, 'HMAC secret'))
    .update(json, 'utf8')
    .digest('hex');

  const cipher = crypto.createCipheriv(
    'aes-256-cbc',
    normalizeKey(aesKey, 'AES key'),
    iv
  );

  return Buffer.concat([
    iv,
    cipher.update(`${json}|${hmac}`, 'utf8'),
    cipher.final(),
  ]);
}

/** Generate a fresh 256-bit key as a 64-character hex string. */
export function generateKeyHex(): string {
  return crypto.randomBytes(KEY_BYTES).toString('hex');
}
