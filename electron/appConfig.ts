import { app, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../src/config/env";

const CONFIG_FILENAME = "config.json";

const TEMPLATE = {
  backendUrl: "ws://localhost:8080",
  authToken: "change-me-to-a-long-random-string",
  deviceId: "pc-1",
  deviceName: "My PC",
  scanIntervalMs: 30000,
};

function configPath(): string {
  return path.join(app.getPath("userData"), CONFIG_FILENAME);
}

/**
 * A packaged build has no predictable working directory and no reliable
 * place next to the executable to keep a `.env` file — the common
 * "portable" installer format actually runs from a temp extraction, not
 * the folder the user downloaded it into, so anything colocated with the
 * .exe disappears at runtime. Config lives in Electron's standard per-user
 * data directory instead (works the same regardless of installer format),
 * and on first run this writes a template there and tells the user where
 * to edit it, rather than crashing on a missing value.
 */
export function loadConfigOrPrompt(): Config | null {
  const file = configPath();

  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(TEMPLATE, null, 2));
    dialog.showErrorBox(
      "Home Relay Agent — first-time setup",
      `Created a config file for you at:\n\n${file}\n\n` +
        "Edit it with your backend's URL and auth token, then restart this app."
    );
    return null;
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    dialog.showErrorBox(
      "Home Relay Agent — invalid config",
      `${file} isn't valid JSON. Fix it or delete it to get a fresh template, then restart.`
    );
    return null;
  }

  const backendUrl = raw.backendUrl;
  const authToken = raw.authToken;
  const deviceId = raw.deviceId;
  if (typeof backendUrl !== "string" || typeof authToken !== "string" || typeof deviceId !== "string") {
    dialog.showErrorBox(
      "Home Relay Agent — invalid config",
      `${file} is missing backendUrl, authToken, or deviceId. Check it against the template and restart.`
    );
    return null;
  }

  return {
    backendUrl,
    authToken,
    deviceId,
    deviceName: typeof raw.deviceName === "string" ? raw.deviceName : deviceId,
    scanIntervalMs: Number(raw.scanIntervalMs ?? 30_000),
  };
}
