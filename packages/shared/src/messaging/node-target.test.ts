import { describe, expect, test } from 'bun:test';
import { resolveNodeTarget } from './node-target';

const lookup = {
  localNodeId: 'aa11',
  localName: 'Home',
  nodes: [
    { id: 'aa11', name: 'Home', online: true },
    { id: 'bb22', name: 'Office', online: true },
    { id: 'cc33', name: 'office-spare', online: false },
    { id: 'dd44', name: 'Lab', online: false },
  ],
};

describe('resolveNodeTarget', () => {
  test('empty and self resolve to local', () => {
    expect(resolveNodeTarget('', lookup)).toMatchObject({
      ok: true,
      local: true,
      node: { id: 'aa11' },
    });
    expect(resolveNodeTarget('self', lookup)).toMatchObject({ ok: true, local: true });
    expect(resolveNodeTarget(undefined, lookup)).toMatchObject({ ok: true, local: true });
  });

  test('matches exact id first', () => {
    expect(resolveNodeTarget('bb22', lookup)).toMatchObject({
      ok: true,
      local: false,
      node: { id: 'bb22', name: 'Office' },
    });
  });

  test('matches name case-insensitively', () => {
    expect(resolveNodeTarget('office', lookup)).toMatchObject({
      ok: true,
      node: { id: 'bb22' },
    });
  });

  test('matches a unique prefix of id or name', () => {
    expect(resolveNodeTarget('lab', lookup)).toMatchObject({
      ok: false,
      error: 'offline',
      candidates: [{ id: 'dd44' }],
    });
    expect(resolveNodeTarget('bb', lookup)).toMatchObject({ ok: true, node: { id: 'bb22' } });
  });

  test('reports unknown when nothing matches', () => {
    expect(resolveNodeTarget('zzz', lookup)).toEqual({
      ok: false,
      error: 'unknown',
      input: 'zzz',
    });
  });

  test('reports ambiguous prefix matches', () => {
    const result = resolveNodeTarget('off', lookup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('ambiguous');
    expect(result.candidates?.map((node) => node.id).sort()).toEqual(['bb22', 'cc33']);
  });

  test('offline remote nodes return offline even on exact id', () => {
    expect(resolveNodeTarget('dd44', lookup)).toMatchObject({
      ok: false,
      error: 'offline',
    });
  });

  test('local node is never treated as offline', () => {
    const offlineLocal = {
      ...lookup,
      nodes: [{ id: 'aa11', name: 'Home', online: false }],
    };
    expect(resolveNodeTarget('aa11', offlineLocal)).toMatchObject({ ok: true, local: true });
  });
});
