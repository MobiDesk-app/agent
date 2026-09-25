import { z } from "zod";

// Wire protocol for the "files" WebRTC data channel (separate from "input").
// Only one download runs at a time (matches the existing single-viewer MVP
// limitation elsewhere in this project) — a second download request while
// one is in flight gets a "busy" error instead of interleaving chunks.

export const fileRequestSchema = z.discriminatedUnion("type", [
  // path omitted/null lists the roots: drives + quick-access folders.
  z.object({ type: z.literal("list"), requestId: z.string().min(1), path: z.string().nullable() }),
  z.object({ type: z.literal("download"), requestId: z.string().min(1), path: z.string().min(1) }),
  z.object({ type: z.literal("cancel-download"), requestId: z.string().min(1) }),
]);
export type FileRequest = z.infer<typeof fileRequestSchema>;

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string; // ISO timestamp
}

export type FileResponse =
  | { type: "list-result"; requestId: string; path: string | null; entries: FileEntry[] }
  | { type: "list-error"; requestId: string; message: string }
  | { type: "download-start"; requestId: string; name: string; size: number }
  | { type: "download-error"; requestId: string; message: string }
  | { type: "download-complete"; requestId: string };
