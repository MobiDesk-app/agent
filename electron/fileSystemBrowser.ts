import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { FileEntry } from "../src/rtc/fileProtocol";

/**
 * Full filesystem read access, granted to whoever the phone's WebRTC
 * connection already authenticated as. This isn't a new privilege boundary:
 * the same connection already has live mouse/keyboard control of this PC,
 * which can already read any file through the UI. See agent/README.md's
 * threat-model note.
 */
export async function listRoots(): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  const home = os.homedir();

  const quickAccess: Array<[name: string, dirPath: string]> = [
    ["Desktop", path.join(home, "Desktop")],
    ["Documents", path.join(home, "Documents")],
    ["Downloads", path.join(home, "Downloads")],
    ["Home", home],
  ];
  for (const [name, dirPath] of quickAccess) {
    if (!fs.existsSync(dirPath)) continue;
    const stat = fs.statSync(dirPath);
    entries.push({ name, path: dirPath, isDirectory: true, size: 0, modifiedAt: stat.mtime.toISOString() });
  }

  if (process.platform === "win32") {
    for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (fs.existsSync(drive)) {
        entries.push({ name: drive, path: drive, isDirectory: true, size: 0, modifiedAt: new Date(0).toISOString() });
      }
    }
  } else {
    entries.push({ name: "/", path: "/", isDirectory: true, size: 0, modifiedAt: new Date(0).toISOString() });
  }

  return entries;
}

export async function listDirectory(dirPath: string): Promise<FileEntry[]> {
  const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    const fullPath = path.join(dirPath, dirent.name);
    try {
      const stat = await fs.promises.stat(fullPath);
      entries.push({
        name: dirent.name,
        path: fullPath,
        isDirectory: stat.isDirectory(),
        size: stat.isDirectory() ? 0 : stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // Skip entries we can't stat (permission-denied junctions, broken
      // symlinks) instead of failing the whole directory listing.
    }
  }
  return entries;
}
