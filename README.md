# Home Relay — PC Agent

The background process that runs on your home PC. It connects to the
[backend](../backend), reports what's on your LAN, streams your screen over
WebRTC, applies remote mouse/keyboard input to the real OS, lets a connected
phone browse and download files, and — as of Phase 6 — can be packaged into
a real installable app (`.exe`/`.dmg`/`.AppImage`) instead of needing
`npm`/`node` on the target PC.

## What's built so far

**Phase 2 — LAN reporting (plain Node, no GUI needed):**
- Connects to the backend as a `"pc"` client and authenticates
- Scans the OS ARP table (`arp -a`) to find other devices on the LAN — no
  router login needed, works with any router brand
- Reports that list to the backend every `SCAN_INTERVAL_MS` (default 30s)
- Reconnects automatically with exponential backoff if the backend connection
  drops

**Phase 3 — screen capture + WebRTC (Electron):**
- Runs as a hidden (no visible window) Electron app instead of a plain Node
  process, because screen capture and WebRTC both require a Chromium
  renderer, which only Electron provides
- Captures the primary screen via `desktopCapturer` + `getUserMedia`
- Answers a phone's WebRTC offer (the agent is always the *answerer* — see
  `backend/README.md`'s signaling sequence) and streams the screen as a
  video track

**Phase 4 — remote input injection:**
- The phone's `RTCDataChannel` messages are parsed, schema-validated, and
  applied to the real OS via `@nut-tree-fork/nut-js`
- Supported today: `mousemove` (as a 0..1 fraction of screen width/height,
  so it's independent of the phone's resolution), `mousedown`/`mouseup`,
  `wheel`, `keydown`/`keyup`

**Phase 5 — file browsing and download:**
- A second `RTCDataChannel` (label `"files"`, alongside `"input"`) lets a
  connected phone list directories and download files
- Listing starts at "roots" — quick-access folders (Desktop, Documents,
  Downloads, Home) plus every drive letter on Windows (or `/` elsewhere) —
  and descends from there
- Downloads stream in 16KB chunks with real backpressure: the renderer
  pauses the main process's file read stream once the data channel's own
  send buffer passes 1MB, and resumes it once the buffer drains below 256KB
- Only one download runs at a time, matching the existing single-viewer
  limitation elsewhere in this project

**Phase 6 — packaging as a real installable app:**
- `npm run dist` (`electron-builder`) produces a real installer — NSIS
  `.exe` on Windows, `.dmg` on macOS, `.AppImage` on Linux — so the PC being
  controlled just needs the built app, not a clone of this repo or Node
  installed
- Config moved off `.env`/`dotenv` for the Electron build specifically: a
  packaged app has no predictable working directory, and the common
  "portable" installer format actually runs from a temp extraction, not the
  folder the user downloaded it into, so nothing colocated with the `.exe`
  survives to runtime. `electron/appConfig.ts` reads/writes
  `config.json` in Electron's standard per-user data directory instead
  (`app.getPath("userData")`), which is stable regardless of installer
  format
- First run with no config file: writes a template `config.json` there and
  shows a native dialog telling the user exactly where to edit it, then
  exits, rather than crashing on a missing `BACKEND_URL`
- `@nut-tree-fork/nut-js`'s native binary is rebuilt for Electron's Node ABI
  automatically via `electron-builder install-app-deps`, wired as this
  package's `postinstall` script

## What's NOT built yet

- Full keyboard key-name mapping (see "Not done yet" below)
- Multiple simultaneous viewers (a second phone's offer replaces the first
  session rather than running both — logged as a warning when it happens)
- Concurrent downloads (a second download request while one is active gets
  a "busy" `download-error`)
- Auto-start on login, tray icon
- Code signing — the built installer is unsigned, so Windows SmartScreen
  and macOS Gatekeeper will warn on a fresh machine (see "Run it")

## Architecture

```
src/                          framework-agnostic core (no Electron/DOM types)
  config/env.ts               loads & validates .env once at startup
  types/
    lanDevice.ts               shared shape, mirrors backend's LanDevice
    messages.ts                 wire protocol: zod schemas for inbound (backend->agent),
                                 plain types for outbound (agent->backend)
  network/
    arpParser.ts                pure functions: raw `arp -a` text -> LanDevice[]
                                 (Windows and Unix formats, no side effects, easy to test)
    arpScanner.ts                the one function that actually shells out to `arp -a`
  signaling/
    signalingClient.ts           owns the WebSocket: auth handshake, schema validation,
                                 reconnect-with-backoff. Emits typed events
                                 (authenticated / signal / error / disconnected) —
                                 nothing else touches the raw socket
  rtc/
    rtcSessionHandler.ts         the extension point: defines the function signature
                                 that handles an incoming WebRTC signal. `agent.ts`
                                 depends only on this interface, never on Electron.
    signalPayload.ts             shared shapes for what's inside a signal's payload
                                 (offer/answer/ice-candidate) — no DOM lib types, so
                                 it compiles under both src/'s Node-only tsconfig and
                                 the renderer's DOM+Node one
    inputEvent.ts                zod schema + type for one remote input event
                                 (mousemove/mousedown/mouseup/wheel/keydown/keyup) —
                                 validated where it's parsed off the data channel,
                                 not just cast
    fileProtocol.ts               zod schema for a file-browsing request (list/download/
                                 cancel-download) plus the FileEntry/FileResponse shapes.
                                 No DOM types, same reasoning as the other rtc/ files.
  agent.ts                      orchestrator: wires SignalingClient + arpScanner +
                                 an RtcSessionHandler together via constructor injection
  index.ts                      plain-Node entrypoint (Phase 2 mode: LAN reporting only,
                                 no screen sharing — handleSignal is the "not implemented"
                                 stub). Useful for testing/headless boxes with no display.

electron/                     Electron-specific (DOM + Node lib, its own tsconfig)
  main.ts                      real entrypoint (`npm run electron:start`, or the
                                 packaged app). Loads config via appConfig.ts, builds
                                 the same Agent core as index.ts, wires a real
                                 RtcSessionHandler that forwards signals into the hidden
                                 renderer, and applies validated input events via
                                 inputInjector.ts
  appConfig.ts                  loads config.json from Electron's per-user data
                                 directory (not .env — see Phase 6 above for why),
                                 writing a first-run template and showing a dialog
                                 telling the user where to edit it if none exists yet
  electronRtcHandler.ts         implements RtcSessionHandler for Electron: main has
                                 no WebRTC stack, so it forwards signal messages via
                                 webContents.send to the renderer that does
  inputInjector.ts              the only file that calls nut-js. Converts a validated
                                 InputEvent into real mouse/keyboard action, using
                                 Electron's own `screen` module to turn a 0..1 ratio
                                 into real pixel coordinates
  fileSystemBrowser.ts           the only file that lists directories: listRoots() and
                                 listDirectory(path), both plain fs/os calls
  downloadManager.ts             streams at most one file at a time with pause/resume,
                                 so backpressure from the data channel can throttle a
                                 real fs.ReadStream instead of buffering a whole file
                                 in memory
  preload.ts                    contextBridge surface exposed to the renderer: get a
                                 screen source id, send/receive signal messages, send
                                 an input event, list/download files — nothing else
                                 (contextIsolation on, nodeIntegration off)
  renderer/
    capture.html                minimal host page, loads the bundled capture.js
    capture.ts                  the only file that actually calls getUserMedia and
                                 owns the RTCPeerConnection: answers offers, streams
                                 the screen, and is the trust boundary for both input
                                 events and file requests (validates them before they
                                 ever reach main/the OS)
  test/
    phone-simulator.html        a plain-browser stand-in for the React Native app,
                                 used to manually verify screen share + input (see below)
    file-protocol-check.ts       a Node script using @roamhq/wrtc to drive the "files"
                                 channel end-to-end against the real backend + agent —
                                 lists directories and downloads a file, checked
                                 byte-for-byte via sha256 (see "Verified so far")
```

### Why it's split this way

- **`src/` never imports Electron or DOM types.** Everything under `src/`
  compiles under a Node-only tsconfig and has no idea it's running inside
  Electron. `electron/` is the only place that knows about `BrowserWindow`,
  `desktopCapturer`, `RTCPeerConnection`, or `nut-js`. This is what let
  Phase 3 and Phase 4 both reuse `Agent`, `SignalingClient`, and `scanLan`
  completely unchanged.
- **`rtcSessionHandler.ts` is the seam.** It was written in Phase 2, before
  any WebRTC code existed, specifically so later phases could implement it
  without touching `agent.ts` or `signalingClient.ts`. `electronRtcHandler.ts`
  is that implementation — a few lines that forward to the renderer.
- **Main and renderer are split because they run in different worlds.**
  Electron's main process is plain Node — no DOM, no WebRTC, and no native
  mouse/keyboard bindings from nut-js either (they load fine in Node, but the
  *reason* input handling lives in main isn't "nut-js needs Node" so much as
  "the renderer shouldn't have raw OS control — only main does, behind the
  validated IPC boundary"). Only a renderer (Chromium) has
  `getUserMedia`/`RTCPeerConnection`. So signaling and OS input both live in
  main, and everything WebRTC-shaped lives in the hidden renderer, bridged by
  a narrow `contextBridge` API in `preload.ts` — not a wide-open
  `nodeIntegration: true`, which would hand the renderer full Node/filesystem
  access it doesn't need.
- **Input events are validated twice, at two different boundaries.**
  `capture.ts` validates first, because that's the real trust boundary —
  the data channel message came straight from whatever's on the other end
  of the connection. `main.ts` validates again before calling
  `applyInputEvent`, because IPC between our own processes is still a
  boundary worth not blindly trusting, and the check is nearly free.
- **`signalPayload.ts` and `inputEvent.ts` avoid DOM lib types** like
  `RTCIceCandidateInit`, unavailable in `src/`'s Node-only compile. Defining
  our own structurally-equivalent shapes keeps them usable on both sides of
  the main/renderer split.
- **The renderer script is bundled with esbuild, not just compiled with
  `tsc`.** It imports from `src/rtc/*`, and `tsc`'s CommonJS output uses
  `require`/`exports`, which don't exist in a plain `<script>` tag (no Node
  integration in that renderer, by design). esbuild inlines every import
  (including `zod`) into one dependency-free IIFE bundle instead.
- **File listing and downloading are two different IPC shapes on purpose.**
  `files:list` is `ipcMain.handle`/`invoke` — a single request, a single
  response, a natural fit for a Promise. Downloading is a stream of events
  over time (start, N chunks, complete-or-error), so it uses fire-and-forget
  `send`/`on` instead, matching how `signal` and input events already work.
- **Only `downloadManager.ts` touches a live `fs.ReadStream`.** Keeping
  pause/resume/cancel behind one small class (rather than scattering stream
  state through `main.ts`) is what makes the backpressure logic in
  `capture.ts` (watch `bufferedAmount`, call `pauseDownload`/`resumeDownload`)
  safe to reason about — the stream can only be in one of a few known states.
- **Full filesystem read access is intentional, not an oversight.**
  `fileSystemBrowser.ts`'s doc comment covers this: the same already-open
  connection that can browse files can already move the mouse and type,
  which is a strictly bigger capability. File browsing doesn't raise the
  threat model, it just uses a permission the connection already has.

### Accepted risk

`npm audit` flags a moderate-severity, no-fix-available vulnerability in
`jimp`/`file-type`, pulled in transitively by `@nut-tree-fork/nut-js`'s
image-recognition feature set. This agent never calls those APIs — only
`mouse`/`keyboard` — so the vulnerable code path is never reached. Revisit if
nut-js ships a version with that dependency removed or made optional.

## Verified so far

**Phase 2:** ran the real backend and the plain-Node agent together —
authenticated as `pc-1`, ran a real `arp -a` scan, and confirmed the LAN
device list was persisted in the backend's `data/devices.json`.

**Phase 3:** ran the real backend and the actual Electron app (not a mock),
then used `electron/test/phone-simulator.html` (served over local HTTP, a
plain browser page standing in for the React Native app) to drive the whole
pipeline for real: offer → relayed through the backend → renderer calls
`desktopCapturer`/`getUserMedia` for real → answer + ICE exchanged → the
simulator's `<video>` element rendered the **real, live desktop screen**,
confirmed visually via a screenshot, not just "connection established" logs.

**Phase 4:** with that same connection open, added a data channel and two
buttons to the simulator ("move to 10%,10%" / "move to 90%,90%"), and
independently queried the real OS cursor position via a separate PowerShell
`System.Windows.Forms.Cursor::Position` check before and after each click:

- Move to (10%, 10%) on a 1920×1080 screen → cursor landed at exactly
  **(192, 108)**.
- Move to (90%, 90%) → cursor landed at exactly **(1728, 972)**.

Both match the requested ratio exactly, confirmed by a tool outside the
Electron app itself — not by trusting the app's own logs.

**Phase 5:** wrote `electron/test/file-protocol-check.ts`, a Node script
using `@roamhq/wrtc` to stand in for the phone app (since no mobile emulator
is available in this environment), and ran it against the real backend and
real Electron agent:

1. Requested the root listing → got back 5 entries (drives + quick-access
   folders).
2. Wrote a 50KB file of random bytes to the OS temp directory, listed that
   directory over the channel, and confirmed the file appeared with the
   right name and path.
3. Requested a download of that file, collected every binary chunk in
   order, and compared the reassembled bytes against the original —
   **exact length match and identical SHA-256 hash**.

This confirms the list → download → chunked-transfer protocol works
end-to-end through the real backend's signaling relay, not just in isolation.

**Phase 6:** ran `npm run dist` for real and got back an actual NSIS
installer plus an unpacked build. Rather than run the installer (which
would modify this machine's Program Files/registry for a test), launched
the unpacked `release/win-unpacked/Home Relay Agent.exe` directly — the
real packaged binary, not `npx electron .` or any dev tooling:

1. First run with no `config.json` yet: it created
   `%APPDATA%\home-relay-agent\config.json` with the documented template
   and exited, exactly as designed.
2. Restarted the real backend and relaunched the same packaged `.exe` —
   it authenticated as `pc-1` and reported a real LAN scan, confirmed by
   reading the backend's `data/devices.json` afterward and seeing the
   report land there.

## Run it

**Phase 2 mode (LAN reporting only, no screen share, no GUI needed):**
```bash
npm install
cp .env.example .env   # AUTH_TOKEN must match the backend's .env exactly
npm run dev             # runs src/index.ts, restarts on change
```

**Phase 3/4 mode (full agent, Electron):**
```bash
npm install
cp .env.example .env
npm run electron:start  # builds electron/ + src/ with tsc, bundles the
                         # renderer with esbuild, then launches Electron
```

Make sure the backend is running first (`cd ../backend && npm run dev`).

Type-check everything (src/ with Node lib, electron/ with Node+DOM lib):
```bash
npm run typecheck
```

**Packaging a real installable app (Phase 6):**
```bash
npm run dist   # builds electron/ + src/, then runs electron-builder
```
Produces, under `release/`:
- Windows: `Home Relay Agent Setup <version>.exe` (NSIS installer)
- macOS: a `.dmg` (run on a Mac, or via a cross-build CI service)
- Linux: a `.AppImage`

**First run on the target PC:** the app writes
`config.json` to its per-user data directory (`%APPDATA%\home-relay-agent\`
on Windows, `~/Library/Application Support/home-relay-agent/` on macOS,
`~/.config/home-relay-agent/` on Linux) and shows a dialog with that exact
path, then exits. Edit that file — set `backendUrl`, `authToken` (must match
the backend's `AUTH_TOKEN`), and a unique `deviceId` — and launch it again.

The installer is **unsigned** (no code-signing certificate configured), so
Windows SmartScreen / macOS Gatekeeper will show an "unknown publisher"
warning on a fresh machine — click through it ("More info" → "Run anyway"
on Windows) or set up a real certificate in `package.json`'s `build.win`/
`build.mac` config if this needs to go to people other than yourself.

### Manually testing the full pipeline

With the backend and `npm run electron:start` both running:
```bash
npx http-server -p 5511 electron/test   # serve the simulator over HTTP —
                                         # it needs real WebSocket/WebRTC,
                                         # which don't run from a file:// page
```
Open `http://localhost:5511/phone-simulator.html`, click **Connect to pc-1**
— you should see your own screen streamed back within a couple of seconds —
then try the two "Move cursor" buttons and watch your real mouse jump.

To test file browsing specifically, run (with the backend and
`npm run electron:start` both running):
```bash
npx tsx electron/test/file-protocol-check.ts
```

## What's next

**Full keyboard mapping.** `inputEvent.ts`'s `key` field currently must
already match a `nut-js` `Key` enum member name exactly (e.g. `"A"`,
`"Enter"`, `"Space"`). Translating from what the [React Native app](../mobile-app)
actually sends into that enum is a follow-up now that the app defines what
shape key names arrive in.
