/** Mirrors the backend's LanDevice shape (backend/src/types/device.ts). */
export interface LanDevice {
  ip: string;
  mac: string;
  name?: string;
}
