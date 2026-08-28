import { describe, expect, test } from 'bun:test';
import { findByName, isMeshTransport, matchesTransport } from './mesh-row.ts';

describe('isMeshTransport', () => {
  test('accepts the three live transports', () => {
    expect(isMeshTransport('dc')).toBe(true);
    expect(isMeshTransport('relay')).toBe(true);
    expect(isMeshTransport('ws-secure')).toBe(true);
  });

  test('rejects unknown values', () => {
    expect(isMeshTransport('lan')).toBe(false);
    expect(isMeshTransport('')).toBe(false);
  });
});

describe('findByName', () => {
  const nodes = [
    { id: 'aaa', name: 'self' },
    { id: 'bbb', name: 'node-b' },
  ];

  test('matches name or id', () => {
    expect(findByName(nodes, 'self')?.id).toBe('aaa');
    expect(findByName(nodes, 'bbb')?.name).toBe('node-b');
  });
});

describe('matchesTransport', () => {
  test('requires online and exact transport', () => {
    expect(matchesTransport({ online: true, transport: 'dc' }, 'dc')).toBe(true);
    expect(matchesTransport({ online: true, transport: 'relay' }, 'dc')).toBe(false);
    expect(matchesTransport({ online: false, transport: 'dc' }, 'dc')).toBe(false);
    expect(matchesTransport(undefined, 'dc')).toBe(false);
  });
});
