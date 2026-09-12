import { describe, expect, test } from 'bun:test';
import { PeerPathRttMemory } from './peer-path-rtt';

describe('PeerPathRttMemory', () => {
  test('bestMs takes the minimum across kinds and ignores expired samples', () => {
    let now = 1_000_000;
    const memory = new PeerPathRttMemory({ now: () => now, ttlMs: 10_000 });
    memory.record('p', { kind: 'tcp-connect', rttMs: 95 });
    memory.record('p', { kind: 'dc', rttMs: 180 });
    expect(memory.bestMs('p')).toBe(95);
    expect(memory.bestMs('p', ['dc'])).toBe(180);
    now += 20_000;
    memory.record('p', { kind: 'dc', rttMs: 170 });
    expect(memory.bestMs('p')).toBe(170);
    expect(memory.bestMs('p', ['tcp-connect'])).toBeNull();
  });

  test('unknown peer and invalid samples yield null', () => {
    const memory = new PeerPathRttMemory({ now: () => 0 });
    expect(memory.bestMs('nobody')).toBeNull();
    memory.record('p', { kind: 'dc', rttMs: Number.NaN });
    memory.record('p', { kind: 'dc', rttMs: -1 });
    expect(memory.bestMs('p')).toBeNull();
  });

  test('perKindLimit keeps only the newest samples per kind', () => {
    let now = 0;
    const memory = new PeerPathRttMemory({ now: () => now, perKindLimit: 2 });
    memory.record('p', { kind: 'dc', rttMs: 50 });
    now += 1;
    memory.record('p', { kind: 'dc', rttMs: 60 });
    now += 1;
    memory.record('p', { kind: 'dc', rttMs: 70 });
    expect(memory.samplesOf('p').map((s) => s.rttMs)).toEqual([60, 70]);
    expect(memory.bestMs('p')).toBe(60);
  });

  test('prune drops expired samples and empty peers', () => {
    let now = 0;
    const memory = new PeerPathRttMemory({ now: () => now, ttlMs: 100 });
    memory.record('a', { kind: 'dc', rttMs: 10 });
    now = 50;
    memory.record('b', { kind: 'dc', rttMs: 20 });
    now = 120;
    memory.prune();
    expect(memory.bestMs('a')).toBeNull();
    expect(memory.samplesOf('a')).toEqual([]);
    expect(memory.bestMs('b')).toBe(20);
    memory.forget('b');
    expect(memory.bestMs('b')).toBeNull();
  });
});
