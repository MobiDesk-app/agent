import type { SignalMessage } from "../types/messages";

/**
 * Handles an incoming WebRTC signaling message (offer/answer/ICE candidate)
 * for a specific peer. Not implemented yet — this is the extension point
 * for the next phase: screen capture (Electron's desktopCapturer) and
 * input injection (nut-js) plug in behind this exact signature, so nothing
 * in signaling/agent.ts needs to change when that lands.
 */
export type RtcSessionHandler = (message: SignalMessage) => void;

export const notImplementedRtcHandler: RtcSessionHandler = (message) => {
  console.warn(
    `[rtc] received a "${(message.payload as { kind?: string })?.kind ?? "?"}" signal from ${message.from}, ` +
      "but screen sharing isn't implemented yet (next phase)."
  );
};
