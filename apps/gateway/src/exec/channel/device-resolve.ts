import type { Device } from '@vibeterm/shared';
import { getAllDevices, getDeviceById } from '../../db';

export interface DeviceSource {
  getById(id: string): Device | null;
  getAll(): Device[];
}

const dbSource: DeviceSource = { getById: getDeviceById, getAll: getAllDevices };

export function resolveExecDevice(
  ref: string | undefined,
  source: DeviceSource = dbSource
): Device | null {
  if (ref === undefined || ref === '') {
    return source.getAll().find((device) => device.type === 'local') ?? null;
  }
  const byId = source.getById(ref);
  if (byId) return byId;
  const all = source.getAll();
  const exact = all.find((device) => device.name === ref);
  if (exact) return exact;
  const lower = ref.toLowerCase();
  return all.find((device) => device.name.toLowerCase() === lower) ?? null;
}
