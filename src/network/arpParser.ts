import type { LanDevice } from "../types/lanDevice";

const BROADCAST_MAC = "ff:ff:ff:ff:ff:ff";

function normalizeMac(raw: string): string {
  return raw.toLowerCase().replace(/-/g, ":");
}

function isUsableEntry(ip: string, mac: string): boolean {
  if (mac === BROADCAST_MAC) return false;
  if (mac.startsWith("01:00:5e")) return false; // IPv4 multicast MAC range
  if (ip.startsWith("224.") || ip.startsWith("239.")) return false; // multicast IP
  if (ip === "255.255.255.255") return false;
  return true;
}

/**
 * Parses `arp -a` output on Windows, e.g.:
 *   Interface: 192.168.1.100 --- 0xe
 *     Internet Address      Physical Address      Type
 *     192.168.1.1           00-11-22-33-44-55     dynamic
 */
export function parseWindowsArpOutput(output: string): LanDevice[] {
  const lineRe = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2}){5})\s+\w+/;
  return collect(output, lineRe);
}

/**
 * Parses `arp -a` output on macOS/Linux, e.g.:
 *   ? (192.168.1.1) at 00:11:22:33:44:55 [ether] on en0
 */
export function parseUnixArpOutput(output: string): LanDevice[] {
  const lineRe = /\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/;
  return collect(output, lineRe);
}

function collect(output: string, lineRe: RegExp): LanDevice[] {
  const devices: LanDevice[] = [];
  for (const line of output.split("\n")) {
    const match = lineRe.exec(line);
    if (!match) continue;
    const ip = match[1]!;
    const mac = normalizeMac(match[2]!);
    if (isUsableEntry(ip, mac)) devices.push({ ip, mac });
  }
  return devices;
}

export function parseArpOutput(output: string, platform: NodeJS.Platform): LanDevice[] {
  return platform === "win32" ? parseWindowsArpOutput(output) : parseUnixArpOutput(output);
}
