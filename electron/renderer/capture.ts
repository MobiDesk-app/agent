import { isSignalPayload } from "../../src/rtc/signalPayload";
import type { IceCandidateInit } from "../../src/rtc/signalPayload";
import { inputEventSchema } from "../../src/rtc/inputEvent";
import { fileRequestSchema } from "../../src/rtc/fileProtocol";
import type { FileResponse, FileEntry } from "../../src/rtc/fileProtocol";

type DownloadEvent =
  | { kind: "start"; requestId: string; name: string; size: number }
  | { kind: "chunk"; requestId: string; data: Uint8Array }
  | { kind: "error"; requestId: string; message: string }
  | { kind: "complete"; requestId: string };

// Exposed by electron/preload.ts via contextBridge — this is the *only*
// bridge into the main process; no Node/Electron APIs otherwise.
interface RelayBridge {
  getPrimaryScreenSource: () => Promise<{ id: string; name: string }>;
  onIncomingSignal: (
    callback: (message: { from: string; payload: unknown; iceServers?: RTCIceServer[] }) => void
  ) => void;
  sendOutgoingSignal: (target: string, payload: unknown) => void;
  sendInputEvent: (event: unknown) => void;
  listFiles: (dirPath: string | null) => Promise<unknown>;
  requestDownload: (requestId: string, filePath: string) => void;
  pauseDownload: (requestId: string) => void;
  resumeDownload: (requestId: string) => void;
  cancelDownload: (requestId: string) => void;
  onDownloadEvent: (callback: (event: DownloadEvent) => void) => void;
}
declare const window: Window & { relay: RelayBridge };

// Chromium-specific getUserMedia constraints for screen capture aren't part
// of the standard lib.dom.d.ts MediaTrackConstraints type.
interface DesktopCaptureConstraints {
  audio: false;
  video: {
    mandatory: {
      chromeMediaSource: "desktop";
      chromeMediaSourceId: string;
    };
  };
}

// Only used if the backend didn't attach ICE servers to the offer (an older
// backend): direct connections only, no TURN relay.
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

const BUFFERED_AMOUNT_HIGH = 1024 * 1024; // pause reading the file above 1MB queued
const BUFFERED_AMOUNT_LOW = 256 * 1024; // resume once the queue drains below this

let activePeerId: string | null = null;
let peerConnection: RTCPeerConnection | null = null;
let captureStream: MediaStream | null = null;
let filesChannel: RTCDataChannel | null = null;
// setRemoteDescription doesn't happen until after the (potentially slow —
// IPC round-trip + getUserMedia) capture stream is ready, but ICE
// candidates from the peer can arrive during that window. Queue them
// instead of calling addIceCandidate before there's a remote description
// to add them to.
let remoteDescriptionSet = false;
let pendingIceCandidates: IceCandidateInit[] = [];

function sendFileResponse(response: FileResponse): void {
  filesChannel?.send(JSON.stringify(response));
}

function setupFilesChannel(channel: RTCDataChannel): void {
  filesChannel = channel;
  channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;

  channel.onmessage = (msgEvent) => {
    let json: unknown;
    try {
      json = JSON.parse(msgEvent.data);
    } catch {
      return console.warn("[capture] dropped malformed file-request JSON");
    }
    const result = fileRequestSchema.safeParse(json);
    if (!result.success) {
      return console.warn("[capture] dropped file request that failed validation:", json);
    }
    void handleFileRequest(result.data);
  };
}

async function handleFileRequest(request: ReturnType<typeof fileRequestSchema.parse>): Promise<void> {
  if (request.type === "list") {
    try {
      // main.ts (our own trusted code) guarantees this shape; only `path`
      // above came from the network and needed validation.
      const entries = (await window.relay.listFiles(request.path)) as FileEntry[];
      sendFileResponse({ type: "list-result", requestId: request.requestId, path: request.path, entries });
    } catch (err) {
      sendFileResponse({
        type: "list-error",
        requestId: request.requestId,
        message: err instanceof Error ? err.message : "failed to list directory",
      });
    }
    return;
  }
  if (request.type === "download") {
    window.relay.requestDownload(request.requestId, request.path);
    return;
  }
  if (request.type === "cancel-download") {
    window.relay.cancelDownload(request.requestId);
  }
}

// Registered once — download events are forwarded to whichever files
// channel is currently open, applying backpressure from the data channel's
// own send buffer instead of reading the whole file into memory up front.
window.relay.onDownloadEvent((event) => {
  if (!filesChannel) return;
  switch (event.kind) {
    case "start":
      sendFileResponse({ type: "download-start", requestId: event.requestId, name: event.name, size: event.size });
      return;
    case "chunk": {
      // Re-wrapped to satisfy lib.dom's ArrayBufferView<ArrayBuffer> overload
      // (event.data's backing buffer type is ArrayBufferLike, not ArrayBuffer).
      filesChannel.send(new Uint8Array(event.data));
      if (filesChannel.bufferedAmount > BUFFERED_AMOUNT_HIGH) {
        window.relay.pauseDownload(event.requestId);
        filesChannel.onbufferedamountlow = () => window.relay.resumeDownload(event.requestId);
      }
      return;
    }
    case "error":
      sendFileResponse({ type: "download-error", requestId: event.requestId, message: event.message });
      return;
    case "complete":
      sendFileResponse({ type: "download-complete", requestId: event.requestId });
      return;
  }
});

async function getCaptureStream(): Promise<MediaStream> {
  if (captureStream) return captureStream;
  const source = await window.relay.getPrimaryScreenSource();
  const constraints: DesktopCaptureConstraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: source.id,
      },
    },
  };
  captureStream = await navigator.mediaDevices.getUserMedia(constraints as unknown as MediaStreamConstraints);
  return captureStream;
}

function resetPeerConnection(): void {
  peerConnection?.close();
  peerConnection = null;
  filesChannel = null;
  activePeerId = null;
  remoteDescriptionSet = false;
  pendingIceCandidates = [];
}

function setupInputChannel(channel: RTCDataChannel): void {
  // This is the real trust boundary for input events — they come straight
  // off the wire from whatever's on the other end of the connection — so
  // they're schema-validated here before ever reaching the main process or
  // the OS.
  channel.onmessage = (msgEvent) => {
    let json: unknown;
    try {
      json = JSON.parse(msgEvent.data);
    } catch {
      return console.warn("[capture] dropped malformed input event JSON");
    }
    const result = inputEventSchema.safeParse(json);
    if (!result.success) {
      return console.warn("[capture] dropped input event that failed validation:", json);
    }
    window.relay.sendInputEvent(result.data);
  };
}

/**
 * The agent is always the *answerer*: the phone app initiates by sending an
 * offer (see backend/README.md's signaling sequence), so this is the only
 * entry point that creates a new RTCPeerConnection.
 */
async function handleOffer(from: string, sdp: string, iceServers: RTCIceServer[]): Promise<void> {
  // MVP limitation: one viewer at a time. A second phone's offer while
  // another is connected replaces the first rather than running both.
  if (activePeerId && activePeerId !== from) {
    console.warn(`[capture] replacing existing session with ${activePeerId} for new offer from ${from}`);
  }
  resetPeerConnection();
  activePeerId = from;

  const pc = new RTCPeerConnection({ iceServers });
  peerConnection = pc;

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    window.relay.sendOutgoingSignal(from, {
      kind: "ice-candidate",
      candidate: event.candidate.toJSON(),
    });
  };

  // The phone opens two data channels alongside the video track: "input"
  // for mouse/keyboard, "files" for browsing/downloading. Branch on label
  // rather than assuming which one arrives first.
  pc.ondatachannel = (event) => {
    if (event.channel.label === "input") {
      setupInputChannel(event.channel);
    } else if (event.channel.label === "files") {
      setupFilesChannel(event.channel);
    } else {
      console.warn(`[capture] ignoring data channel with unknown label "${event.channel.label}"`);
    }
  };

  const stream = await getCaptureStream();
  for (const track of stream.getTracks()) pc.addTrack(track, stream);

  await pc.setRemoteDescription({ type: "offer", sdp });
  remoteDescriptionSet = true;
  for (const candidate of pendingIceCandidates) {
    await pc.addIceCandidate(candidate);
  }
  pendingIceCandidates = [];

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  window.relay.sendOutgoingSignal(from, { kind: "answer", sdp: answer.sdp ?? "" });
}

async function handleIceCandidate(candidate: IceCandidateInit): Promise<void> {
  if (!peerConnection) return;
  if (!remoteDescriptionSet) {
    pendingIceCandidates.push(candidate);
    return;
  }
  await peerConnection.addIceCandidate(candidate);
}

window.relay.onIncomingSignal((message) => {
  if (!isSignalPayload(message.payload)) {
    console.warn("[capture] ignoring signal with unrecognized payload:", message.payload);
    return;
  }
  const { payload } = message;
  if (payload.kind === "offer") {
    void handleOffer(message.from, payload.sdp, message.iceServers ?? FALLBACK_ICE_SERVERS);
  } else if (payload.kind === "ice-candidate") {
    void handleIceCandidate(payload.candidate);
  }
  // "answer" is never expected here — the agent only ever answers, it
  // doesn't initiate, so it should never receive one.
});

console.log("[capture] renderer ready, waiting for an incoming offer");
