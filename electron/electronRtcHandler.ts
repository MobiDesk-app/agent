import type { BrowserWindow } from "electron";
import type { RtcSessionHandler } from "../src/rtc/rtcSessionHandler";

/**
 * Implements RtcSessionHandler (defined in src/rtc, framework-agnostic) for
 * Electron specifically: the main process has no WebRTC stack of its own,
 * so it forwards every incoming signal to the hidden capture window's
 * renderer, which does have one.
 */
export function createElectronRtcHandler(getCaptureWindow: () => BrowserWindow): RtcSessionHandler {
  return (message) => {
    getCaptureWindow().webContents.send("rtc:incoming-signal", message);
  };
}
