/**
 * Integration test for the "files" data channel protocol, run against the
 * REAL backend and REAL Electron agent (not mocks). Standing in for the
 * React Native app with a Node WebRTC client (@roamhq/wrtc) instead of a
 * browser, since a mobile emulator isn't available in this environment.
 *
 * Usage: backend and `npm run electron:start` must already be running.
 *   npx tsx electron/test/file-protocol-check.ts
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import WebSocket from "ws";
import wrtc from "@roamhq/wrtc";

const TOKEN = process.env.AUTH_TOKEN ?? "change-me-to-a-long-random-string";
const TARGET = process.env.DEVICE_ID ?? "pc-1";
const BACKEND_URL = process.env.BACKEND_URL ?? "ws://localhost:8080";

const TEST_FILE_SIZE = 50 * 1024; // spans several 16KB chunks
const testFilePath = path.join(os.tmpdir(), "home-relay-file-protocol-check.bin");
const testFileContent = crypto.randomBytes(TEST_FILE_SIZE);
fs.writeFileSync(testFilePath, testFileContent);
const expectedHash = crypto.createHash("sha256").update(testFileContent).digest("hex");

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const ws = new WebSocket(BACKEND_URL);
  const pc = new wrtc.RTCPeerConnection({ iceServers: [] });

  const inputChannel = pc.createDataChannel("input");
  const filesChannel = pc.createDataChannel("files");

  pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate) {
      ws.send(
        JSON.stringify({
          type: "signal",
          target: TARGET,
          payload: { kind: "ice-candidate", candidate: event.candidate.toJSON() },
        })
      );
    }
  };
  pc.ontrack = () => {}; // agent always attaches video; this test ignores it

  ws.on("open", () => {
    console.log("ws open, authenticating");
    ws.send(JSON.stringify({ type: "auth", token: TOKEN, deviceId: "file-test-client", role: "app" }));
  });

  ws.on("message", async (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "auth_ok") {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: "signal", target: TARGET, payload: { kind: "offer", sdp: offer.sdp } }));
      console.log("sent offer");
      return;
    }

    if (msg.type === "signal") {
      const payload = msg.payload;
      if (payload.kind === "answer") {
        await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        console.log("applied answer");
      } else if (payload.kind === "ice-candidate") {
        await pc.addIceCandidate(payload.candidate);
      }
      return;
    }

    if (msg.type === "error") {
      fail(`backend error: ${msg.message}`);
    }
  });

  let requestSeq = 0;
  const nextRequestId = () => `req-${++requestSeq}`;

  const receivedChunks: Buffer[] = [];
  let downloadRequestId: string | null = null;

  filesChannel.onopen = () => {
    console.log("files channel open, requesting root listing");
    filesChannel.send(JSON.stringify({ type: "list", requestId: nextRequestId(), path: null }));
  };

  filesChannel.onmessage = (event: MessageEvent) => {
    if (typeof event.data === "string") {
      const msg = JSON.parse(event.data);
      handleControlMessage(msg);
    } else {
      // Binary chunk. wrtc delivers Node Buffer/ArrayBuffer depending on
      // version; normalize to Buffer either way.
      const chunk = Buffer.isBuffer(event.data) ? event.data : Buffer.from(event.data as ArrayBuffer);
      receivedChunks.push(chunk);
    }
  };

  function handleControlMessage(msg: Record<string, unknown>): void {
    console.log("files <-", msg.type, JSON.stringify(msg).slice(0, 150));

    if (msg.type === "list-result" && msg.path === null) {
      const entries = msg.entries as Array<{ name: string; path: string; isDirectory: boolean }>;
      if (entries.length === 0) fail("root listing came back empty");
      console.log(`PASS: root listing returned ${entries.length} entries`);

      const tmpDir = os.tmpdir();
      filesChannel.send(JSON.stringify({ type: "list", requestId: nextRequestId(), path: tmpDir }));
      return;
    }

    if (msg.type === "list-result") {
      const entries = msg.entries as Array<{ name: string; path: string; isDirectory: boolean }>;
      const found = entries.find((e) => e.path === testFilePath);
      if (!found) fail(`test file not found in listing of ${msg.path}`);
      console.log(`PASS: test file found in directory listing (${found?.name})`);

      downloadRequestId = nextRequestId();
      filesChannel.send(JSON.stringify({ type: "download", requestId: downloadRequestId, path: testFilePath }));
      return;
    }

    if (msg.type === "download-start") {
      if (msg.size !== TEST_FILE_SIZE) fail(`download-start size ${msg.size} !== expected ${TEST_FILE_SIZE}`);
      console.log(`PASS: download-start reported correct size (${msg.size} bytes)`);
      return;
    }

    if (msg.type === "download-error") {
      fail(`download-error: ${msg.message}`);
    }

    if (msg.type === "download-complete") {
      const received = Buffer.concat(receivedChunks);
      const receivedHash = crypto.createHash("sha256").update(received).digest("hex");
      if (received.length !== TEST_FILE_SIZE) {
        fail(`received ${received.length} bytes, expected ${TEST_FILE_SIZE}`);
      }
      if (receivedHash !== expectedHash) {
        fail(`sha256 mismatch: expected ${expectedHash}, got ${receivedHash}`);
      }
      console.log(`PASS: downloaded file matches byte-for-byte (sha256 ${receivedHash})`);
      console.log("\nALL CHECKS PASSED");
      fs.unlinkSync(testFilePath);
      ws.close();
      pc.close();
      process.exit(0);
    }
  }

  setTimeout(() => fail("timed out waiting for the pipeline to complete"), 20_000);
}

main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)));
