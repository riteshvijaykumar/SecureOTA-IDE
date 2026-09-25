import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import { decodePacket, type DecodeFailure, type TrackingPayload } from '../security/packet-crypto';
import type { DeviceRegistry } from '../security/device-registry';

/**
 * MOD-07 — Live Device Panel listener.
 *
 * Binds the tracking port and runs every datagram through the four
 * verification layers before it is allowed to touch the panel:
 *
 *   1. AES-256-CBC decrypt      — needs this device's key
 *   2. HMAC-SHA256 verify       — constant-time, needs this device's secret
 *   3. MAC registry check       — device must have been flashed by this IDE
 *   4. Counter check            — must strictly advance (replay protection)
 *
 * Layers 1 and 2 live in packet-crypto; 3 and 4 in DeviceRegistry. This class
 * sequences them and owns the socket.
 *
 * The listener never throws on a bad packet. An open UDP port receives
 * arbitrary traffic — broadcast noise from unrelated software, and anything an
 * attacker cares to send — so a rejected packet is an ordinary event that
 * increments a counter, not an error.
 */

export const DEFAULT_TRACKING_PORT = 5007;

/** A device is shown offline once this long has passed with no accepted packet. */
export const OFFLINE_AFTER_MS = 90_000;

export type RejectionReason = DecodeFailure | 'unknown-device' | 'replayed-counter';

export interface DeviceStatus {
  readonly mac: string;
  readonly sketch: string;
  readonly version: string;
  readonly ip: string;
  readonly status: string;
  readonly lastSeen: string;
  readonly online: boolean;
}

export interface ListenerStats {
  received: number;
  accepted: number;
  rejected: Record<RejectionReason, number>;
}

function emptyStats(): ListenerStats {
  return {
    received: 0,
    accepted: 0,
    rejected: {
      'packet-too-small': 0,
      'bad-block-alignment': 0,
      'decrypt-failed': 0,
      'malformed-frame': 0,
      'hmac-mismatch': 0,
      'malformed-json': 0,
      'missing-fields': 0,
      'unknown-device': 0,
      'replayed-counter': 0,
    },
  };
}

export declare interface DeviceListener {
  on(event: 'device', listener: (status: DeviceStatus) => void): this;
  on(event: 'rejected', listener: (reason: RejectionReason, from: string) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export class DeviceListener extends EventEmitter {
  private socket: dgram.Socket | undefined;
  private readonly seen = new Map<string, DeviceStatus>();
  private stats = emptyStats();

  constructor(
    private readonly registry: DeviceRegistry,
    private readonly port: number = DEFAULT_TRACKING_PORT
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.socket) {
      return;
    }

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('message', (message, remote) => {
      // Deliberately not awaited: the handler must return immediately so the
      // socket keeps draining. Verification failures are reported by event.
      void this.handlePacket(message, remote.address).catch((error) =>
        this.emit('error', error instanceof Error ? error : new Error(String(error)))
      );
    });

    socket.on('error', (error) => this.emit('error', error));

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.port, () => {
        socket.off('error', reject);
        // The agent broadcasts to 255.255.255.255; without this the datagrams
        // are delivered only when the IDE happens to share the sender's subnet
        // broadcast domain in the way the OS expects.
        try {
          socket.setBroadcast(true);
        } catch {
          // Not fatal — unicast packets still arrive.
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.socket = undefined;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  /**
   * Run one datagram through all four layers.
   *
   * Exposed (rather than private) so the pipeline can be tested without
   * binding a real socket.
   */
  async handlePacket(packet: Buffer, from: string): Promise<boolean> {
    this.stats.received++;

    // Layers 1 and 2 need the device's keys, but the MAC is only readable
    // *after* decryption — so the candidate set is every registered device.
    // Fleets here are a handful of boards flashed from one IDE, so trying each
    // is acceptable; if that stopped holding, the agent would need to send its
    // MAC in an authenticated cleartext header.
    for (const record of await this.registry.list()) {
      const result = decodePacket(packet, record.aesKey, record.hmacSecret);
      if (!result.ok) {
        continue;
      }

      // Layer 3: the keys that decrypted it must belong to the MAC it claims.
      // Without this check a device could impersonate another registered one.
      if (result.payload.mac !== record.mac) {
        this.reject('unknown-device', from);
        return false;
      }

      // Layer 4.
      const advanced = await this.registry.accept(result.payload.mac, result.payload.cnt, {
        ip: result.payload.ip,
        version: result.payload.version,
      });
      if (!advanced) {
        this.reject('replayed-counter', from);
        return false;
      }

      this.stats.accepted++;
      this.publish(result.payload);
      return true;
    }

    // No registered key decoded it. Report the failure mode a hypothetical
    // decode would have produced, so an operator can tell "not our device"
    // from "our device, wrong key".
    const diagnosis = await this.diagnose(packet);
    this.reject(diagnosis, from);
    return false;
  }

  private async diagnose(packet: Buffer): Promise<RejectionReason> {
    const records = await this.registry.list();
    if (records.length === 0) {
      return 'unknown-device';
    }
    const first = decodePacket(packet, records[0].aesKey, records[0].hmacSecret);
    return first.ok ? 'unknown-device' : first.reason;
  }

  private reject(reason: RejectionReason, from: string): void {
    this.stats.rejected[reason]++;
    this.emit('rejected', reason, from);
  }

  private publish(payload: TrackingPayload): void {
    const status: DeviceStatus = {
      mac: payload.mac,
      sketch: payload.sketch,
      version: payload.version,
      ip: payload.ip,
      status: payload.status,
      lastSeen: new Date().toISOString(),
      online: true,
    };
    this.seen.set(payload.mac, status);
    this.emit('device', status);
  }

  /** Snapshot for the panel, with staleness applied. */
  devices(now: number = Date.now()): DeviceStatus[] {
    return [...this.seen.values()].map((device) => ({
      ...device,
      online: now - Date.parse(device.lastSeen) < OFFLINE_AFTER_MS,
    }));
  }

  statistics(): ListenerStats {
    return {
      received: this.stats.received,
      accepted: this.stats.accepted,
      rejected: { ...this.stats.rejected },
    };
  }

  resetStatistics(): void {
    this.stats = emptyStats();
  }
}
