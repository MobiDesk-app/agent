import { BrowserWindow, shell } from "electron";
import path from "node:path";
import { pairWithAccount } from "../src/pairing/pairingClient";
import type { PairingCredentials, PairingUpdate } from "../src/pairing/pairingClient";

/**
 * Shows a small window with the 6-digit link code and waits until the user
 * enters it in the web/phone app. Resolves with this PC's credentials.
 * Closing the window quits the app (there's nothing useful to do unlinked).
 */
export function runPairingWindow(serverUrl: string, deviceName: string): Promise<PairingCredentials | null> {
  const win = new BrowserWindow({
    width: 420,
    height: 540,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: "Link this PC — Home Relay",
    backgroundColor: "#0c0d10",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "pairingPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  // Links in the page (the web app address) open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  let cancelled = false;
  let lastUpdate: PairingUpdate = { state: "requesting" };
  const push = (update: PairingUpdate) => {
    lastUpdate = update;
    if (!win.isDestroyed()) win.webContents.send("pairing:update", { ...update, deviceName, serverUrl });
  };
  win.webContents.on("did-finish-load", () => push(lastUpdate));
  win.loadFile(path.join(__dirname, "renderer", "pairing.html"));

  return new Promise((resolve) => {
    win.on("closed", () => {
      cancelled = true;
      resolve(null);
    });
    pairWithAccount(serverUrl, deviceName, push, () => cancelled).then((creds) => {
      if (!creds) return;
      resolve(creds);
      // Leave the "Linked!" message up briefly, then close.
      setTimeout(() => !win.isDestroyed() && win.destroy(), 2500);
    });
  });
}
