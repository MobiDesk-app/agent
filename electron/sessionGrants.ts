/**
 * What the current remote viewer is allowed to do, as granted by the backend
 * on their offer: "screen", "files", "control" (mouse and keyboard). The PC
 * owner gets all three; people the owner shares with get what the owner
 * chose. Checked here in the main process, the last stop before the real OS
 * and filesystem, and again in the renderer, which sits on the network side.
 *
 * One viewer at a time, like the renderer: the latest offer replaces the
 * session. A new permission added on the backend must be enforced here too,
 * or it does nothing; an unknown one is simply never allowed.
 */
type Grants = ReadonlySet<string> | "all";

let active: { peer: string; grants: Grants } | null = null;

/** `grants` undefined = an older backend that only ever relays the owner. */
export function startSession(peer: string, grants: string[] | undefined): void {
  active = { peer, grants: grants ? new Set(grants) : "all" };
}

export function isActivePeer(peer: string): boolean {
  return active?.peer === peer;
}

export function endSession(peer: string): void {
  if (active?.peer === peer) active = null;
}

export function allowed(permission: string): boolean {
  return !!active && (active.grants === "all" || active.grants.has(permission));
}
