import { injectable } from 'inversify';
import * as fs from 'fs/promises';
import * as path from 'path';
import { generateKeyHex } from './packet-crypto';

/**
 * Registry of devices this IDE has flashed (MOD-07, layers 3 and 4).
 *
 * Only a device that was flashed by this installation has an entry, and only
 * an entry carries the per-device AES key and HMAC secret needed to decode its
 * packets. A device absent from the registry therefore cannot produce a packet
 * this IDE will accept, which is what "MAC registry check" means in practice.
 *
 * Keys are minted per device rather than per installation (design decision 8):
 * extracting the keys from one device's flash compromises that device alone.
 */

export interface DeviceRecord {
  mac: string;
  sketchName: string;
  aesKey: string;
  hmacSecret: string;
  /** Highest counter value accepted so far. Replay protection, layer 4. */
  lastCounter: number;
  firstSeen: string;
  lastSeen: string | null;
  lastIp: string | null;
  lastVersion: string | null;
}

interface RegistryFile {
  version: 1;
  devices: Record<string, DeviceRecord>;
}

export const REGISTRY_FILE_NAME = 'device-registry.json';

function emptyRegistry(): RegistryFile {
  return { version: 1, devices: {} };
}

@injectable()
export class DeviceRegistry {
  private cache: RegistryFile | undefined;

  constructor(private readonly storageDir: string) {}

  private get filePath(): string {
    return path.join(this.storageDir, REGISTRY_FILE_NAME);
  }

  private async load(): Promise<RegistryFile> {
    if (this.cache) {
      return this.cache;
    }
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as RegistryFile;
      // A corrupted or hand-edited file must not take the panel down; fall
      // back to empty rather than throwing on every packet thereafter.
      this.cache =
        parsed && typeof parsed === 'object' && parsed.devices
          ? { version: 1, devices: parsed.devices }
          : emptyRegistry();
    } catch {
      this.cache = emptyRegistry();
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    const registry = await this.load();
    await fs.mkdir(this.storageDir, { recursive: true });
    // Atomic replace: a crash mid-write must not leave a truncated registry,
    // which would silently orphan every device this IDE has ever flashed.
    const temporary = `${this.filePath}.tmp`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify(registry, null, 2)}\n`,
      'utf8'
    );
    await fs.rename(temporary, this.filePath);
  }

  /**
   * Provision keys for a device about to be flashed. Re-provisioning an
   * existing MAC keeps its keys, so a device that is reflashed is not orphaned
   * from its own history, but resets the counter — the device's NVS counter
   * restarts at zero on a fresh flash, and refusing to reset here would reject
   * every packet it subsequently sends.
   */
  async provision(mac: string, sketchName: string): Promise<DeviceRecord> {
    const registry = await this.load();
    const key = mac.toUpperCase();
    const existing = registry.devices[key];

    const record: DeviceRecord = existing
      ? { ...existing, sketchName, lastCounter: 0 }
      : {
          mac: key,
          sketchName,
          aesKey: generateKeyHex(),
          hmacSecret: generateKeyHex(),
          lastCounter: 0,
          firstSeen: new Date().toISOString(),
          lastSeen: null,
          lastIp: null,
          lastVersion: null,
        };

    registry.devices[key] = record;
    await this.persist();
    return record;
  }

  async get(mac: string): Promise<DeviceRecord | undefined> {
    const registry = await this.load();
    return registry.devices[mac.toUpperCase()];
  }

  async list(): Promise<DeviceRecord[]> {
    const registry = await this.load();
    return Object.values(registry.devices);
  }

  /**
   * Record an accepted packet. Rejects a non-advancing counter (layer 4) and
   * returns false, so the caller drops the packet.
   */
  async accept(
    mac: string,
    counter: number,
    seen: { ip?: string; version?: string; at?: string }
  ): Promise<boolean> {
    const registry = await this.load();
    const record = registry.devices[mac.toUpperCase()];
    if (!record) {
      return false;
    }
    if (counter <= record.lastCounter) {
      return false;
    }

    record.lastCounter = counter;
    record.lastSeen = seen.at ?? new Date().toISOString();
    record.lastIp = seen.ip ?? record.lastIp;
    record.lastVersion = seen.version ?? record.lastVersion;

    await this.persist();
    return true;
  }

  async forget(mac: string): Promise<boolean> {
    const registry = await this.load();
    const key = mac.toUpperCase();
    if (!registry.devices[key]) {
      return false;
    }
    delete registry.devices[key];
    await this.persist();
    return true;
  }

  /** Drop the in-memory cache; the next read reloads from disk. */
  invalidate(): void {
    this.cache = undefined;
  }
}
