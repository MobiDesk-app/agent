import fs from "node:fs";

const CHUNK_SIZE = 16 * 1024; // safe under WebRTC data channel message limits

export interface DownloadCallbacks {
  onStart: (name: string, size: number) => void;
  onChunk: (chunk: Buffer) => void;
  onError: (message: string) => void;
  onComplete: () => void;
}

/**
 * Streams at most one file at a time (matches the single-viewer MVP
 * limitation elsewhere in this project) and supports pause/resume so the
 * caller can apply backpressure from the data channel's own buffer instead
 * of reading the whole file into memory or overflowing the channel.
 */
export class DownloadManager {
  private activeRequestId: string | null = null;
  private activeStream: fs.ReadStream | null = null;

  isBusy(): boolean {
    return this.activeRequestId !== null;
  }

  start(requestId: string, filePath: string, callbacks: DownloadCallbacks): void {
    if (this.isBusy()) {
      callbacks.onError("another download is already in progress");
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      callbacks.onError("file not found or not accessible");
      return;
    }
    if (stat.isDirectory()) {
      callbacks.onError("cannot download a directory");
      return;
    }

    this.activeRequestId = requestId;
    const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
    this.activeStream = stream;

    callbacks.onStart(filePath.split(/[\\/]/).pop() ?? filePath, stat.size);

    stream.on("data", (chunk) => callbacks.onChunk(chunk as Buffer));
    stream.on("end", () => {
      this.clear(requestId);
      callbacks.onComplete();
    });
    stream.on("error", (err) => {
      this.clear(requestId);
      callbacks.onError(err.message);
    });
  }

  pause(requestId: string): void {
    if (this.activeRequestId === requestId) this.activeStream?.pause();
  }

  resume(requestId: string): void {
    if (this.activeRequestId === requestId) this.activeStream?.resume();
  }

  cancel(requestId: string): void {
    if (this.activeRequestId !== requestId) return;
    this.activeStream?.destroy();
    this.clear(requestId);
  }

  /** Stops whatever is streaming, e.g. because the viewer changed or lost access. */
  cancelAll(): void {
    if (this.activeRequestId) this.cancel(this.activeRequestId);
  }

  private clear(requestId: string): void {
    if (this.activeRequestId === requestId) {
      this.activeRequestId = null;
      this.activeStream = null;
    }
  }
}
