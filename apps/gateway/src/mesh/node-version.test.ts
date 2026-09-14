import { describe, expect, test } from 'bun:test';
import { nodeVersionMeets, normalizeReportedNodeVersion } from './node-version';

describe('node-version', () => {
  test('normalizeReportedNodeVersion trims, strips _dev, and treats empty as null', () => {
    expect(normalizeReportedNodeVersion('1.1.13')).toBe('1.1.13');
    expect(normalizeReportedNodeVersion('1.1.13_dev')).toBe('1.1.13');
    expect(normalizeReportedNodeVersion('  1.2.0  ')).toBe('1.2.0');
    expect(normalizeReportedNodeVersion('')).toBeNull();
    expect(normalizeReportedNodeVersion('   ')).toBeNull();
    expect(normalizeReportedNodeVersion(null)).toBeNull();
    expect(normalizeReportedNodeVersion(undefined)).toBeNull();
  });

  test('nodeVersionMeets compares the reported version against minVersion', () => {
    expect(nodeVersionMeets('1.1.13', '1.1.13')).toBe(true);
    expect(nodeVersionMeets('1.1.13_dev', '1.1.13')).toBe(true);
    expect(nodeVersionMeets('1.1.12', '1.1.13')).toBe(false);
    expect(nodeVersionMeets(null, '1.1.13')).toBe(false);
    expect(nodeVersionMeets('ver-b', '1.1.13')).toBe(false);
  });
});
