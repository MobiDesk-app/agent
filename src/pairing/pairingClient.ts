/**
 * Links this PC to a user's account. Framework-agnostic (plain fetch), so
 * both the Electron app and the headless Node entrypoint use it.
 *
 *   1. POST /api/pairing/start  -> a 6-digit code to show the user
 *   2. user types the code into the web/phone app (signed in)
 *   3. POST /api/pairing/poll   -> eventually returns this PC's permanent
 *                                  device id + secret
 *
 * The code expires after 10 minutes; a fresh one is requested automatically.
 */

export interface PairingCredentials {
  deviceId: string;
  deviceSecret: string;
}

export type PairingUpdate =
  | { state: "requesting" }
  | { state: "code"; code: string; expiresAt: string }
  | { state: "offline"; message: string }
  | { state: "paired" };

const POLL_INTERVAL_MS = 2_000;
const RETRY_DELAY_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post<T>(serverUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `server returned ${res.status}`);
  return data;
}

export async function pairWithAccount(
  serverUrl: string,
  pcName: string,
  onUpdate: (update: PairingUpdate) => void,
  isCancelled: () => boolean = () => false
): Promise<PairingCredentials | null> {
  while (!isCancelled()) {
    onUpdate({ state: "requesting" });
    let started: { pairingId: string; pollSecret: string; code: string; expiresAt: string };
    try {
      started = await post(serverUrl, "/api/pairing/start", { name: pcName });
    } catch (err) {
      onUpdate({ state: "offline", message: err instanceof Error ? err.message : String(err) });
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    onUpdate({ state: "code", code: started.code, expiresAt: started.expiresAt });

    while (!isCancelled()) {
      await sleep(POLL_INTERVAL_MS);
      let result: { status: string; deviceId?: string; deviceSecret?: string };
      try {
        result = await post(serverUrl, "/api/pairing/poll", { pairingId: started.pairingId, pollSecret: started.pollSecret });
      } catch {
        continue; // transient network error — keep the same code and retry
      }
      if (result.status === "paired" && result.deviceId && result.deviceSecret) {
        onUpdate({ state: "paired" });
        return { deviceId: result.deviceId, deviceSecret: result.deviceSecret };
      }
      if (result.status === "expired") break; // outer loop fetches a fresh code
    }
  }
  return null;
}

/** Accepts "example.com", "https://…", or a legacy "ws(s)://…" address. */
export function normalizeServerUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/^ws(s?):\/\//i, "http$1://");
}

export function toWebSocketUrl(serverUrl: string): string {
  return serverUrl.replace(/^http(s?):\/\//i, "ws$1://");
}
