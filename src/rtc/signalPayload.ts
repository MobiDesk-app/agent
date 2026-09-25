// Framework-agnostic shapes for what flows inside a `signal` message's
// `payload`. Deliberately not using DOM lib types (RTCIceCandidateInit etc.)
// here — this file is imported by src/ (plain Node, no DOM lib) as well as
// by the Electron renderer, so it stays structurally compatible with both
// instead of depending on a lib.dom.d.ts type.
export interface IceCandidateInit {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export type SignalPayload =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice-candidate"; candidate: IceCandidateInit };

export function isSignalPayload(value: unknown): value is SignalPayload {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const kind = (value as { kind: unknown }).kind;
  if (kind === "offer" || kind === "answer") {
    return typeof (value as { sdp?: unknown }).sdp === "string";
  }
  if (kind === "ice-candidate") {
    const candidate = (value as { candidate?: unknown }).candidate;
    return typeof candidate === "object" && candidate !== null && "candidate" in candidate;
  }
  return false;
}
