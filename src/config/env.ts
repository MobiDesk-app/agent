import "dotenv/config";
import os from "node:os";
import { normalizeServerUrl } from "../pairing/pairingClient";

/** Headless (plain Node) mode config, from .env. The Electron app uses electron/appConfig.ts instead. */
export interface Config {
  serverUrl: string;
  deviceName: string;
  scanIntervalMs: number;
  /** Both set once this PC is linked; empty means "pair first". */
  deviceId: string;
  deviceSecret: string;
}

export const config: Config = {
  serverUrl: normalizeServerUrl(process.env.SERVER_URL ?? process.env.BACKEND_URL ?? "http://localhost:8080"),
  deviceName: process.env.DEVICE_NAME ?? os.hostname(),
  scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS ?? 30_000),
  deviceId: process.env.DEVICE_ID ?? "",
  deviceSecret: process.env.DEVICE_SECRET ?? "",
};
