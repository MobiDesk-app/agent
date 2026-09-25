import { exec } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { LanDevice } from "../types/lanDevice";
import { parseArpOutput } from "./arpParser";

const execAsync = promisify(exec);

/**
 * Reads the OS's ARP table (devices this machine has recently talked to on
 * the LAN) — no router login required, works with any router brand.
 * Deliberately just a function, not a class: no state to manage, easy to
 * call from anywhere, easy to test by swapping `parseArpOutput`.
 */
export async function scanLan(): Promise<LanDevice[]> {
  const { stdout } = await execAsync("arp -a");
  return parseArpOutput(stdout, os.platform());
}
