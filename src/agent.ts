import type { SignalingClient } from "./signaling/signalingClient";
import type { RtcSessionHandler } from "./rtc/rtcSessionHandler";
import type { LanDevice } from "./types/lanDevice";

export interface AgentDeps {
  signaling: SignalingClient;
  scanLan: () => Promise<LanDevice[]>;
  handleSignal: RtcSessionHandler;
  scanIntervalMs: number;
}

/**
 * Orchestrates the agent's lifecycle. Depends only on interfaces/functions
 * passed in (constructor injection), so it can be tested with fakes instead
 * of a real socket and a real `arp -a` call.
 */
export class Agent {
  private scanTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: AgentDeps) {
    this.deps.signaling.on("authenticated", () => this.onAuthenticated());
    this.deps.signaling.on("signal", (message) => this.deps.handleSignal(message));
    this.deps.signaling.on("error", (message) => console.error(`[signaling] ${message}`));
    this.deps.signaling.on("disconnected", () => this.onDisconnected());
  }

  start(): void {
    this.deps.signaling.connect();
  }

  stop(): void {
    this.stopScanning();
    this.deps.signaling.close();
  }

  private onAuthenticated(): void {
    console.log("[agent] authenticated with backend");
    this.stopScanning(); // guard against double-start on reconnect
    void this.scanAndReport();
    this.scanTimer = setInterval(() => void this.scanAndReport(), this.deps.scanIntervalMs);
  }

  private onDisconnected(): void {
    console.warn("[agent] disconnected from backend, will retry");
    this.stopScanning();
  }

  private stopScanning(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  private async scanAndReport(): Promise<void> {
    try {
      const devices = await this.deps.scanLan();
      console.log(`[agent] found ${devices.length} device(s) on the LAN`);
      this.deps.signaling.send({ type: "report_lan_devices", devices });
    } catch (err) {
      console.error("[agent] LAN scan failed:", err instanceof Error ? err.message : err);
    }
  }
}
