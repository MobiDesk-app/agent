import { config } from "./config/env";
import { SignalingClient } from "./signaling/signalingClient";
import { scanLan } from "./network/arpScanner";
import { notImplementedRtcHandler } from "./rtc/rtcSessionHandler";
import { Agent } from "./agent";
import { pairWithAccount, toWebSocketUrl } from "./pairing/pairingClient";

async function main() {
  let { deviceId, deviceSecret } = config;

  if (!deviceId || !deviceSecret) {
    console.log(`[agent] this PC isn't linked yet (server: ${config.serverUrl})`);
    const creds = await pairWithAccount(config.serverUrl, config.deviceName, (u) => {
      if (u.state === "code") console.log(`\n  Link code: ${u.code.slice(0, 3)} ${u.code.slice(3)}\n  Sign in to the web or phone app, press "Link a PC" and enter it.\n`);
      if (u.state === "offline") console.warn(`[agent] can't reach the server (${u.message}), retrying…`);
    });
    if (!creds) return;
    ({ deviceId, deviceSecret } = creds);
    console.log("[agent] linked! Add these to .env so it stays linked after a restart:");
    console.log(`DEVICE_ID=${deviceId}\nDEVICE_SECRET=${deviceSecret}\n`);
  }

  const signaling = new SignalingClient({
    url: toWebSocketUrl(config.serverUrl),
    deviceId,
    secret: deviceSecret,
    name: config.deviceName,
  });

  const agent = new Agent({
    signaling,
    scanLan,
    handleSignal: notImplementedRtcHandler,
    scanIntervalMs: config.scanIntervalMs,
    onUnauthorized: () => {
      console.error("[agent] unlinked — remove DEVICE_ID/DEVICE_SECRET from .env and restart to link again");
      process.exit(1);
    },
  });

  agent.start();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`\n[agent] received ${signal}, shutting down`);
      agent.stop();
      process.exit(0);
    });
  }
}

void main();
