import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { serverMessageSchema } from "../types/messages";
import type { AgentMessage, SignalMessage } from "../types/messages";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface SignalingClientOptions {
  url: string;
  token: string;
  deviceId: string;
  name: string;
}

interface SignalingClientEvents {
  authenticated: [deviceId: string];
  signal: [message: SignalMessage];
  error: [message: string];
  disconnected: [];
}

/**
 * Owns the WebSocket connection to the backend: authenticates on connect,
 * validates every inbound message against the schema, and reconnects with
 * backoff on drop. Callers never touch the raw socket — they listen for
 * `authenticated` / `signal` / `error` / `disconnected` and call `send`.
 */
export class SignalingClient extends EventEmitter<SignalingClientEvents> {
  private ws: WebSocket | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private closedByCaller = false;

  constructor(private readonly options: SignalingClientOptions) {
    super();
  }

  connect(): void {
    this.closedByCaller = false;
    this.open();
  }

  send(message: AgentMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.closedByCaller = true;
    this.ws?.close();
  }

  private open(): void {
    const ws = new WebSocket(this.options.url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      this.send({
        type: "auth",
        token: this.options.token,
        deviceId: this.options.deviceId,
        role: "pc",
        name: this.options.name,
      });
    });

    ws.on("message", (raw: Buffer) => this.handleMessage(raw));

    ws.on("close", () => {
      this.emit("disconnected");
      if (!this.closedByCaller) this.scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      this.emit("error", err.message);
    });
  }

  private handleMessage(raw: Buffer): void {
    let json: unknown;
    try {
      json = JSON.parse(raw.toString());
    } catch {
      return void this.emit("error", "received malformed JSON from backend");
    }

    const result = serverMessageSchema.safeParse(json);
    if (!result.success) {
      return void this.emit("error", "received a message that failed schema validation");
    }

    const message = result.data;
    switch (message.type) {
      case "auth_ok":
        return void this.emit("authenticated", message.deviceId);
      case "signal":
        return void this.emit("signal", message);
      case "error":
        return void this.emit("error", `backend error: ${message.message}`);
      case "pong":
        return; // no-op, keepalive only
    }
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    setTimeout(() => {
      if (!this.closedByCaller) this.open();
    }, delay);
  }
}
