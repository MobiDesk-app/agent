# Home Relay — PC Agent

The background process that runs on your home PC. It connects to the
[backend](../backend), reports what's on your LAN, streams your screen over
WebRTC, and — as of Phase 4 — applies remote mouse input to the real OS.

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

## What's NOT built yet

- Full keyboard key-name mapping (see "Not done yet" below)
- Multiple simultaneous viewers (a second phone's offer replaces the first
  session rather than running both — logged as a warning when it happens)
- Auto-start on login, tray icon, packaging/installer

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
  agent.ts                      orchestrator: wires SignalingClient + arpScanner +
                                 an RtcSessionHandler together via constructor injection
  index.ts                      plain-Node entrypoint (Phase 2 mode: LAN reporting only,
                                 no screen sharing — handleSignal is the "not implemented"
                                 stub). Useful for testing/headless boxes with no display.

electron/                     Electron-specific (DOM + Node lib, its own tsconfig)
  main.ts                      real entrypoint (`npm run electron:start`). Builds the
                                 same Agent core as index.ts, wires a real
                                 RtcSessionHandler that forwards signals into the hidden
                                 renderer, and applies validated input events via
                                 inputInjector.ts
  electronRtcHandler.ts         implements RtcSessionHandler for Electron: main has
                                 no WebRTC stack, so it forwards signal messages via
                                 webContents.send to the renderer that does
  inputInjector.ts              the only file that calls nut-js. Converts a validated
                                 InputEvent into real mouse/keyboard action, using
                                 Electron's own `screen` module to turn a 0..1 ratio
                                 into real pixel coordinates
  preload.ts                    contextBridge surface exposed to the renderer:
                                 get a screen source id, send/receive signal messages,
                                 send an input event — nothing else (contextIsolation
                                 on, nodeIntegration off)
  renderer/
    capture.html                minimal host page, loads the bundled capture.js
    capture.ts                  the only file that actually calls getUserMedia and
                                 owns the RTCPeerConnection: answers offers, streams
                                 the screen, and is the trust boundary for input events
                                 (validates them before they ever reach main/the OS)
  test/
    phone-simulator.html        a plain-browser stand-in for the React Native app,
                                 used to manually verify the whole pipeline (see below)
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

## What's next

**Full keyboard mapping.** `inputEvent.ts`'s `key` field currently must
already match a `nut-js` `Key` enum member name exactly (e.g. `"A"`,
`"Enter"`, `"Space"`). Translating from what a real keyboard or the phone
app's touch keyboard actually sends into that enum is a follow-up — the
React Native app is the next major piece of work and will define what shape
key names actually arrive in.
