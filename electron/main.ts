import { app, BrowserWindow, desktopCapturer, ipcMain } from "electron";
import path from "node:path";
import { config } from "../src/config/env";
import { SignalingClient } from "../src/signaling/signalingClient";
import { scanLan } from "../src/network/arpScanner";
import { Agent } from "../src/agent";
import { createElectronRtcHandler } from "./electronRtcHandler";

// This process never shows a window to the user — it's a background agent.
// The single hidden BrowserWindow exists only because screen capture and
// WebRTC require a renderer (Chromium) context; the main process itself has
// neither a DOM nor a WebRTC stack.
let captureWindow: BrowserWindow;

function createCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "capture.html"));
  // The capture renderer has no window of its own to inspect, so forward
  // its console output into the agent's own logs.
  win.webContents.on("console-message", (_event, _level, message) => {
    console.log(`[renderer] ${message}`);
  });
  return win;
}

app.whenReady().then(() => {
  captureWindow = createCaptureWindow();

  const signaling = new SignalingClient({
    url: config.backendUrl,
    token: config.authToken,
    deviceId: config.deviceId,
    name: config.deviceName,
  });

  const agent = new Agent({
    signaling,
    scanLan,
    handleSignal: createElectronRtcHandler(() => captureWindow),
    scanIntervalMs: config.scanIntervalMs,
  });
  agent.start();

  // Renderer asks main for a screen source id because desktopCapturer is
  // main-process-only; it then uses that id in its own getUserMedia call.
  ipcMain.handle("desktop-sources:primary", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 0, height: 0 },
    });
    const primary = sources[0];
    if (!primary) throw new Error("no screen source available to capture");
    return { id: primary.id, name: primary.name };
  });

  // Renderer produces answers/ICE candidates; only main talks to the backend.
  ipcMain.on("rtc:outgoing-signal", (_event, target: string, payload: unknown) => {
    signaling.send({ type: "signal", target, payload });
  });

  // Keep running with no windows open — this is a background agent, not a
  // normal app the user quits by closing a window.
  app.on("window-all-closed", () => {});
});
