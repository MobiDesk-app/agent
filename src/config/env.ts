import "dotenv/config";

export interface Config {
  backendUrl: string;
  authToken: string;
  deviceId: string;
  deviceName: string;
  scanIntervalMs: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config: Config = {
  backendUrl: required("BACKEND_URL"),
  authToken: required("AUTH_TOKEN"),
  deviceId: required("DEVICE_ID"),
  deviceName: process.env.DEVICE_NAME ?? required("DEVICE_ID"),
  scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS ?? 30_000),
};
