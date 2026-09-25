# Home Relay — PC Agent

The background process that runs on your home PC. This is **Phase 2** of the
plan: it connects to the [backend](../backend), reports what's on your LAN,
and is the foundation the screen-sharing piece plugs into next.

## What's built in this phase

- Connects to the backend as a `"pc"` client and authenticates
- Scans the OS ARP table (`arp -a`) to find other devices on the LAN — no
  router login needed, works with any router brand
- Reports that list to the backend every `SCAN_INTERVAL_MS` (default 30s)
- Reconnects automatically with exponential backoff if the backend connection
  drops
- Has a wired-up but **not yet implemented** hook for incoming WebRTC signals
  (offer/answer/ICE) — see "Not done yet"

## What's NOT built yet

- Screen capture and streaming (the actual "see my PC screen" part)
- Remote mouse/keyboard input injection
- Running as an Electron app (needed for `desktopCapturer` — this phase runs
  as a plain Node process since LAN scanning doesn't need it)

## Architecture

```
src/
  config/env.ts         loads & validates .env once at startup
  types/
    lanDevice.ts         shared shape, mirrors backend's LanDevice
    messages.ts           wire protocol: zod schemas for inbound (backend->agent),
                           plain types for outbound (agent->backend)
  network/
    arpParser.ts          pure functions: raw `arp -a` text -> LanDevice[]
                           (Windows and Unix formats, no side effects, easy to test)
    arpScanner.ts          the one function that actually shells out to `arp -a`
  signaling/
    signalingClient.ts     owns the WebSocket: auth handshake, schema validation,
                           reconnect-with-backoff. Emits typed events
                           (authenticated / signal / error / disconnected) —
                           nothing else touches the raw socket
  rtc/
    rtcSessionHandler.ts   extension point for the next phase. Defines the
                           function signature that will handle incoming WebRTC
                           signals; today it just logs "not implemented yet"
  agent.ts                orchestrator: wires SignalingClient + arpScanner +
                           rtcSessionHandler together via constructor injection
  index.ts                entrypoint: builds the real dependencies and starts Agent
```

### Why it's split this way

- **`arpParser.ts` has zero side effects.** Given a string, it returns
  `LanDevice[]`. `arpScanner.ts` is the only file that touches
  `child_process`. This means the parsing logic (the part most likely to need
  fixing for some router's weird ARP table format) can be tested without
  shelling out to a real OS command.
- **`Agent` takes its dependencies as constructor arguments**
  (`AgentDeps`), not as imports. `index.ts` is the only place that wires real
  implementations together. Swapping `scanLan` for a mock, or `signaling` for
  a fake, doesn't require touching `Agent` itself.
- **`rtcSessionHandler.ts` exists now, doing nothing, on purpose.** The
  signaling client already routes `signal` messages to whatever handler
  `Agent` was given. When screen capture is built, it becomes a new
  implementation of `RtcSessionHandler` — no changes needed in
  `signalingClient.ts` or `agent.ts`.
- **Inbound messages are schema-validated** (`types/messages.ts`,
  `serverMessageSchema`), same reasoning as the backend: don't trust a
  network boundary just because you also wrote the other side.

## Verified so far

Ran the real backend and this agent together, end to end:

1. Backend started on `localhost:8080`.
2. Agent connected, authenticated as `pc-1`, logged
   `"[agent] authenticated with backend"`.
3. Agent ran a real `arp -a` scan on this machine, found 1 device (the
   router), logged `"[agent] found 1 device(s) on the LAN"`.
4. Confirmed in the backend's `data/devices.json` that the device was
   received and persisted under `pc-1` with the correct IP/MAC.

## Run it

```bash
npm install
cp .env.example .env   # AUTH_TOKEN must match the backend's .env exactly
npm run dev             # runs src/index.ts directly, restarts on change
```

Make sure the backend is running first (`cd ../backend && npm run dev`).

Production build:
```bash
npm run build
npm start
```

Type-check only: `npm run typecheck`

## What's next

Turn this into (or wrap it with) an Electron app so it gets:
1. **Screen capture** via `desktopCapturer` + `RTCPeerConnection`, streamed
   over WebRTC once a phone requests a connection (the `signal` messages this
   agent already receives and currently just logs).
2. **Remote input injection** via `@nut-tree/nut-js` on a WebRTC data channel
   alongside the video track.

Both slot in behind `RtcSessionHandler` in `src/rtc/rtcSessionHandler.ts`
without touching the signaling or LAN-scanning code above.
