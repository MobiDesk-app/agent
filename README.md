# Home Relay — PC Agent

The background process that runs on your home PC. It connects to the
[backend](../backend), reports what's on your LAN, and — as of Phase 3 —
captures your screen and streams it over WebRTC to whichever phone connects.

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
- A `RTCDataChannel` for remote input already opens end-to-end; the agent
  logs incoming input events but doesn't act on them yet (see "Not done yet")

## What's NOT built yet

- Remote mouse/keyboard input injection (the data channel works, nothing
  applies the events to the OS)
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
  agent.ts                      orchestrator: wires SignalingClient + arpScanner +
                                 an RtcSessionHandler together via constructor injection
  index.ts                      plain-Node entrypoint (Phase 2 mode: LAN reporting only,
                                 no screen sharing — handleSignal is the "not implemented"
                                 stub). Useful for testing/headless boxes with no display.

electron/                     Electron-specific (DOM + Node lib, its own tsconfig)
  main.ts                      real entrypoint (`npm run electron:start`). Builds the
                                 same Agent core as index.ts, but wires a real
                                 RtcSessionHandler that forwards signals into the
                                 hidden renderer
  electronRtcHandler.ts         implements RtcSessionHandler for Electron: main has
                                 no WebRTC stack, so it forwards signal messages via
                                 webContents.send to the renderer that does
  preload.ts                    contextBridge surface exposed to the renderer:
                                 get a screen source id, send/receive signal messages —
                                 nothing else (contextIsolation on, nodeIntegration off)
  renderer/
    capture.html                minimal host page, loads the bundled capture.js
    capture.ts                  the only file that actually calls getUserMedia and
                                 owns the RTCPeerConnection: answers offers, streams
                                 the screen, listens on the input data channel
  test/
    phone-simulator.html        a plain-browser stand-in for the React Native app,
                                 used to manually verify the whole pipeline (see below)
```

### Why it's split this way

- **`src/` never imports Electron or DOM types.** Everything under `src/`
  compiles under a Node-only tsconfig and has no idea it's running inside
  Electron. `electron/` is the only place that knows about `BrowserWindow`,
  `desktopCapturer`, or `RTCPeerConnection`. This is what let Phase 3 reuse
  `Agent`, `SignalingClient`, and `scanLan` completely unchanged.
- **`rtcSessionHandler.ts` is the seam.** It was written in Phase 2, before
  any WebRTC code existed, specifically so Phase 3 could implement it without
  touching `agent.ts` or `signalingClient.ts`. `electronRtcHandler.ts` is
  that implementation — a few lines that forward to the renderer.
- **Main and renderer are split because they run in different worlds.**
  Electron's main process is plain Node — no DOM, no WebRTC. Only a renderer
  (Chromium) has `getUserMedia`/`RTCPeerConnection`. So signaling (talking to
  the backend over WebSocket) lives in main, and everything WebRTC-shaped
  lives in the hidden renderer, bridged by a narrow `contextBridge` API in
  `preload.ts` — not a wide-open `nodeIntegration: true`, which would hand
  the renderer full Node/filesystem access it doesn't need.
- **`signalPayload.ts` avoids `RTCIceCandidateInit` and friends.** Those are
  DOM lib types, unavailable in `src/`'s Node-only compile. Defining our own
  structurally-equivalent shapes keeps one payload type usable on both sides
  of the main/renderer split.
- **The renderer script is bundled with esbuild, not just compiled with
  `tsc`.** It imports from `src/rtc/signalPayload.ts`, and `tsc`'s CommonJS
  output uses `require`/`exports`, which don't exist in a plain `<script>`
  tag (no Node integration in that renderer, by design). esbuild inlines the
  import into one dependency-free IIFE bundle instead.

## Verified so far

**Phase 2:** ran the real backend and the plain-Node agent together —
authenticated as `pc-1`, ran a real `arp -a` scan, and confirmed the LAN
device list was persisted in the backend's `data/devices.json`.

**Phase 3:** ran the real backend and the actual Electron app (not a mock),
then used `electron/test/phone-simulator.html` (served over local HTTP, a
plain browser page standing in for the React Native app) to drive the whole
pipeline for real:

1. Simulator authenticates to the backend as an `"app"` client.
2. Simulator creates a WebRTC offer and sends it through the backend's
   `signal` relay, targeting `pc-1`.
3. The Electron agent's main process receives it and forwards it to the
   hidden renderer via IPC.
4. The renderer calls `desktopCapturer` + `getUserMedia`, actually captures
   the live screen, answers the offer, and streams the video track back.
5. ICE candidates flow both directions through the same relay.
6. The simulator's `<video>` element renders the **real, live desktop
   screen** — confirmed visually via a screenshot, not just "connection
   established" logs.

This proves the full offer → answer → ICE → media flow works end-to-end
through the real backend, with no shortcuts.

## Run it

**Phase 2 mode (LAN reporting only, no screen share, no GUI needed):**
```bash
npm install
cp .env.example .env   # AUTH_TOKEN must match the backend's .env exactly
npm run dev             # runs src/index.ts, restarts on change
```

**Phase 3 mode (full agent, Electron):**
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

### Manually testing the screen-share pipeline

With the backend and `npm run electron:start` both running:
```bash
npx http-server -p 5511 electron/test   # serve the simulator over HTTP —
                                         # it needs real WebSocket/WebRTC,
                                         # which don't run from a file:// page
```
Open `http://localhost:5511/phone-simulator.html`, click **Connect to pc-1**,
and you should see your own screen streamed back within a couple of seconds.

## What's next

**Remote input injection.** The data channel from phone to PC already
exists — `capture.ts`'s `pc.ondatachannel` handler currently just
`console.log`s incoming messages. The next step is applying them to the OS
with something like `@nut-tree/nut-js` (mouse move/click, keystrokes),
behind the same handler.
