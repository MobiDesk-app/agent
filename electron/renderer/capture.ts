import { isSignalPayload } from "../../src/rtc/signalPayload";
import type { IceCandidateInit } from "../../src/rtc/signalPayload";
import { inputEventSchema } from "../../src/rtc/inputEvent";

// Exposed by electron/preload.ts via contextBridge — this is the *only*
// bridge into the main process; no Node/Electron APIs otherwise.
interface RelayBridge {
  getPrimaryScreenSource: () => Promise<{ id: string; name: string }>;
  onIncomingSignal: (callback: (message: { from: string; payload: unknown }) => void) => void;
  sendOutgoingSignal: (target: string, payload: unknown) => void;
  sendInputEvent: (event: unknown) => void;
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

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

let activePeerId: string | null = null;
let peerConnection: RTCPeerConnection | null = null;
let captureStream: MediaStream | null = null;

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
  activePeerId = null;
}

/**
 * The agent is always the *answerer*: the phone app initiates by sending an
 * offer (see backend/README.md's signaling sequence), so this is the only
 * entry point that creates a new RTCPeerConnection.
 */
async function handleOffer(from: string, sdp: string): Promise<void> {
  // MVP limitation: one viewer at a time. A second phone's offer while
  // another is connected replaces the first rather than running both.
  if (activePeerId && activePeerId !== from) {
    console.warn(`[capture] replacing existing session with ${activePeerId} for new offer from ${from}`);
  }
  resetPeerConnection();
  activePeerId = from;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnection = pc;

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    window.relay.sendOutgoingSignal(from, {
      kind: "ice-candidate",
      candidate: event.candidate.toJSON(),
    });
  };

  // The phone opens this channel to send mouse/keyboard events. This is the
  // real trust boundary for input events — they come straight off the wire
  // from whatever's on the other end of the connection — so they're
  // schema-validated here before ever reaching the main process or the OS.
  pc.ondatachannel = (event) => {
    event.channel.onmessage = (msgEvent) => {
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
  };

  const stream = await getCaptureStream();
  for (const track of stream.getTracks()) pc.addTrack(track, stream);

  await pc.setRemoteDescription({ type: "offer", sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  window.relay.sendOutgoingSignal(from, { kind: "answer", sdp: answer.sdp ?? "" });
}

async function handleIceCandidate(candidate: IceCandidateInit): Promise<void> {
  if (!peerConnection) return;
  await peerConnection.addIceCandidate(candidate);
}

window.relay.onIncomingSignal((message) => {
  if (!isSignalPayload(message.payload)) {
    console.warn("[capture] ignoring signal with unrecognized payload:", message.payload);
    return;
  }
  const { payload } = message;
  if (payload.kind === "offer") {
    void handleOffer(message.from, payload.sdp);
  } else if (payload.kind === "ice-candidate") {
    void handleIceCandidate(payload.candidate);
  }
  // "answer" is never expected here — the agent only ever answers, it
  // doesn't initiate, so it should never receive one.
});

console.log("[capture] renderer ready, waiting for an incoming offer");
