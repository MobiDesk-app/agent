import { config } from "./config/env";
import { SignalingClient } from "./signaling/signalingClient";
import { scanLan } from "./network/arpScanner";
import { notImplementedRtcHandler } from "./rtc/rtcSessionHandler";
import { Agent } from "./agent";

const signaling = new SignalingClient({
  url: config.backendUrl,
  token: config.authToken,
  deviceId: config.deviceId,
  name: config.deviceName,
});

const agent = new Agent({
  signaling,
  scanLan,
  handleSignal: notImplementedRtcHandler,
  scanIntervalMs: config.scanIntervalMs,
});

agent.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n[agent] received ${signal}, shutting down`);
    agent.stop();
    process.exit(0);
  });
}
