import { z } from "zod";
import type { LanDevice } from "./lanDevice";

// ---------------------------------------------------------------------------
// Inbound (backend -> agent). Validated with zod: the backend is trusted
// code we also wrote, but it's still a network boundary — don't let a typo
// or a future protocol change crash the agent with an unchecked field access.
// ---------------------------------------------------------------------------

export const authOkMessageSchema = z.object({
  type: z.literal("auth_ok"),
  deviceId: z.string(),
  role: z.enum(["pc", "app"]),
});

export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export const signalMessageSchema = z.object({
  type: z.literal("signal"),
  from: z.string(),
  payload: z.unknown(),
  // Attached by the backend to offers only: STUN plus, when configured,
  // short-lived TURN credentials for reaching phones on other networks.
  iceServers: z.array(iceServerSchema).optional(),
  // Also on offers only: what this viewer may do ("screen", "files",
  // "control"). Absent = sent by a backend from before sharing existed,
  // which only ever relays the owner, so everything is allowed.
  grants: z.array(z.string()).optional(),
});

/** The backend asks us to end the session with this app (its access shrank). */
export const revokeMessageSchema = z.object({
  type: z.literal("revoke"),
  peer: z.string(),
});

export const errorMessageSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  target: z.string().optional(),
});

export const pongMessageSchema = z.object({
  type: z.literal("pong"),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  authOkMessageSchema,
  signalMessageSchema,
  errorMessageSchema,
  pongMessageSchema,
  revokeMessageSchema,
  // "devices" is only ever sent to role "app"; the agent never requests it,
  // so it's intentionally left unhandled rather than modeled here.
]);

export type SignalMessage = z.infer<typeof signalMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ---------------------------------------------------------------------------
// Outbound (agent -> backend). We control these, plain TS types are enough.
// ---------------------------------------------------------------------------

export type AgentMessage =
  | { type: "auth"; role: "pc"; deviceId: string; secret: string; name: string; features: string[] }
  | { type: "report_lan_devices"; devices: LanDevice[] }
  | { type: "signal"; target: string; payload: unknown }
  | { type: "ping" };
