import { app, safeStorage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeServerUrl } from "../src/pairing/pairingClient";
import type { PairingCredentials } from "../src/pairing/pairingClient";

// The server every installed copy talks to. Change this before building
// the installer for real users (e.g. "https://relay.example.com"); it can
// still be overridden per machine with "serverUrl" in config.json.
export const DEFAULT_SERVER_URL = "https://linkobackend.ghannemhazem.com";

const CONFIG_FILENAME = "config.json";

export interface AppConfig {
  serverUrl: string;
  deviceName: string;
  scanIntervalMs: number;
  credentials: PairingCredentials | null;
}

interface StoredConfig {
  serverUrl?: string;
  backendUrl?: string; // pre-accounts name for serverUrl
  deviceName?: string;
  scanIntervalMs?: number;
  deviceId?: string;
  /** base64 of the OS-encrypted secret (DPAPI on Windows, Keychain on macOS). */
  deviceSecretEncrypted?: string;
  /** Only used where the OS offers no encryption (some Linux setups). */
  deviceSecret?: string;
}

function configPath(): string {
  return path.join(app.getPath("userData"), CONFIG_FILENAME);
}

function readStored(): StoredConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as StoredConfig;
  } catch {
    return {};
  }
}

function writeStored(stored: StoredConfig): void {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
}

/**
 * Config lives in Electron's per-user data directory (a packaged app has no
 * reliable folder next to its .exe). No manual editing is needed: the
 * server address is built in and the device credentials are filled in by
 * the pairing window.
 */
export function loadConfig(): AppConfig {
  const stored = readStored();
  let credentials: PairingCredentials | null = null;

  if (stored.deviceId && stored.deviceSecretEncrypted && safeStorage.isEncryptionAvailable()) {
    try {
      const secret = safeStorage.decryptString(Buffer.from(stored.deviceSecretEncrypted, "base64"));
      credentials = { deviceId: stored.deviceId, deviceSecret: secret };
    } catch {
      credentials = null; // encrypted by another OS user / machine — pair again
    }
  } else if (stored.deviceId && stored.deviceSecret) {
    credentials = { deviceId: stored.deviceId, deviceSecret: stored.deviceSecret };
  }

  return {
    serverUrl: normalizeServerUrl(stored.serverUrl ?? stored.backendUrl ?? DEFAULT_SERVER_URL),
    deviceName: stored.deviceName ?? os.hostname(),
    scanIntervalMs: Number(stored.scanIntervalMs ?? 30_000),
    credentials,
  };
}

export function saveCredentials(credentials: PairingCredentials | null): void {
  const stored = readStored();
  delete stored.deviceId;
  delete stored.deviceSecret;
  delete stored.deviceSecretEncrypted;
  delete stored.backendUrl;
  // Old shared-token fields from before accounts existed.
  delete (stored as Record<string, unknown>).authToken;

  if (credentials) {
    stored.deviceId = credentials.deviceId;
    if (safeStorage.isEncryptionAvailable()) {
      stored.deviceSecretEncrypted = safeStorage.encryptString(credentials.deviceSecret).toString("base64");
    } else {
      stored.deviceSecret = credentials.deviceSecret;
    }
  }
  writeStored(stored);
}
