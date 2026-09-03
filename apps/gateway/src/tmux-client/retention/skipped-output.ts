import { bytesEqual, copyBytes } from './bytes';

type SkippedPaneOutput = {
  deviceId: string;
  paneId: string;
  paneEpoch: Uint8Array;
};

const skippedByDevice = new Map<string, Map<string, SkippedPaneOutput>>();
const skippedByPane = new Map<string, Set<SkippedPaneOutput>>();

function removeRecord(record: SkippedPaneOutput): void {
  const devicePanes = skippedByDevice.get(record.deviceId);
  devicePanes?.delete(record.paneId);
  if (devicePanes?.size === 0) skippedByDevice.delete(record.deviceId);
  const paneRecords = skippedByPane.get(record.paneId);
  paneRecords?.delete(record);
  if (paneRecords?.size === 0) skippedByPane.delete(record.paneId);
}

export function hasDeviceSkippedPaneOutput(deviceId: string, paneId: string): boolean {
  return skippedByDevice.get(deviceId)?.has(paneId) ?? false;
}

export function markSkippedPaneOutput(
  deviceId: string,
  paneId: string,
  paneEpoch: Uint8Array
): void {
  const existing = skippedByDevice.get(deviceId)?.get(paneId);
  if (existing) {
    if (bytesEqual(existing.paneEpoch, paneEpoch)) return;
    removeRecord(existing);
  }
  const record = { deviceId, paneId, paneEpoch: copyBytes(paneEpoch) };
  const devicePanes = skippedByDevice.get(deviceId);
  if (devicePanes) devicePanes.set(paneId, record);
  else skippedByDevice.set(deviceId, new Map([[paneId, record]]));
  const paneRecords = skippedByPane.get(paneId);
  if (paneRecords) paneRecords.add(record);
  else skippedByPane.set(paneId, new Set([record]));
}

export function hasSkippedPaneOutput(paneId: string, paneEpoch: Uint8Array): boolean {
  const records = skippedByPane.get(paneId);
  if (!records) return false;
  for (const record of records) {
    if (bytesEqual(record.paneEpoch, paneEpoch)) return true;
  }
  return false;
}

export function clearSkippedPaneOutput(deviceId: string, paneId: string): void {
  const record = skippedByDevice.get(deviceId)?.get(paneId);
  if (record) removeRecord(record);
}

export function clearSkippedPaneOutputsForDevice(deviceId: string): void {
  const records = skippedByDevice.get(deviceId);
  if (!records) return;
  for (const record of [...records.values()]) removeRecord(record);
}
