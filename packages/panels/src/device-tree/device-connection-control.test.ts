import { describe, expect, test } from 'bun:test';
import type { DeviceConnectionStatus } from '../device-connection';
import { deviceStatusDotClass } from './device-connection-control';

const allStatuses: DeviceConnectionStatus[] = [
  'connected',
  'connecting',
  'disconnected',
  'reconnecting',
  'error',
];

describe('deviceStatusDotClass', () => {
  test('connected is green', () => {
    expect(deviceStatusDotClass('connected')).toBe('bg-emerald-500');
  });

  test('disconnected is grey', () => {
    expect(deviceStatusDotClass('disconnected')).toBe('bg-gray-400');
  });

  test('transient and error states are amber', () => {
    for (const status of ['connecting', 'reconnecting', 'error'] as const) {
      expect(deviceStatusDotClass(status)).toBe('bg-amber-500');
    }
  });

  test('every status maps to a class', () => {
    for (const status of allStatuses) {
      expect(deviceStatusDotClass(status)).toMatch(/^bg-/);
    }
  });
});
