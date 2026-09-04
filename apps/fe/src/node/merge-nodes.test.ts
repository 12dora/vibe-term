// mergeNodes：mesh 成员集 + hub 心跳，外加 hub 独有的「待批准」行。

import { describe, expect, test } from 'bun:test';
import type { MeshNode } from '@tmex/api-client/auth/index';
import type { HubNodeRow } from './hub-api';
import { mergeNodes } from './merge-nodes';

const ENTRY = 'aa'.repeat(16);
const OTHER = 'bb'.repeat(16);
const PENDING_ID = 'cc'.repeat(16);

function meshNode(id: string, name: string): MeshNode {
  return {
    id,
    name,
    publicKey: '',
    online: true,
    loggedIn: true,
    direct_capable: true,
  } as unknown as MeshNode;
}

function hubRow(id: string, extra: Partial<HubNodeRow> = {}): HubNodeRow {
  return {
    id,
    name: `hub-${id.slice(0, 4)}`,
    status: 'enrolled',
    online: true,
    version: '1.1.24',
    last_seen_at: 1_700_000_000_000,
    direct_capable: true,
    ...extra,
  };
}

const MATERIAL = {
  enrollment_id: 'enr-1',
  authorization: 'auth',
  authorization_sig: 'auth-sig',
  certificate: 'cert',
  cert_sig: 'cert-sig',
};

const CONTEXT = { entryNodeId: ENTRY, hubNodeId: null };

describe('mergeNodes 的待批准行', () => {
  test('hub 说 pending 而 mesh 里没有：追加一行离线的待批准，带上 admit 材料', () => {
    const rows = mergeNodes(
      [meshNode(ENTRY, 'entry')],
      [
        hubRow(ENTRY),
        hubRow(PENDING_ID, { admission_status: 'pending', name: 'laptop', ...MATERIAL }),
      ],
      CONTEXT
    );

    expect(rows.map((row) => row.id)).toEqual([ENTRY, PENDING_ID]);
    const pending = rows[1];
    expect(pending.pending).toBe(true);
    expect(pending.online).toBe(false);
    expect(pending.name).toBe('laptop');
    expect(pending.runtimeNodeId).toBe(PENDING_ID);
    expect(pending.version).toBeNull();
    expect(pending.loggedIn).toBe(false);
    expect(pending.admissionStatus).toBe('pending');
    expect(pending.admitMaterial).toEqual({
      enrollmentId: 'enr-1',
      authorization: 'auth',
      authorizationSig: 'auth-sig',
      certificate: 'cert',
      certSig: 'cert-sig',
    });
  });

  test('名字为空时退回 id 前缀', () => {
    const rows = mergeNodes(
      [],
      [hubRow(PENDING_ID, { admission_status: 'pending', name: '  ', ...MATERIAL })],
      CONTEXT
    );
    expect(rows[0].name).toBe(PENDING_ID.slice(0, 8));
  });

  test('材料不全的待批准行照样列出，但没有 admit 材料', () => {
    const rows = mergeNodes(
      [],
      [hubRow(PENDING_ID, { admission_status: 'pending', certificate: 'cert' })],
      CONTEXT
    );
    expect(rows[0].pending).toBe(true);
    expect(rows[0].admitMaterial).toBeNull();
  });

  test('mesh 里已经有的同一台绝不重复列出', () => {
    const rows = mergeNodes(
      [meshNode(ENTRY, 'entry'), meshNode(OTHER, 'other')],
      [hubRow(ENTRY), hubRow(OTHER, { admission_status: 'pending', ...MATERIAL })],
      CONTEXT
    );
    expect(rows.map((row) => row.id)).toEqual([ENTRY, OTHER]);
    expect(rows[1].pending).toBe(false);
    expect(rows[1].admissionStatus).toBe('pending');
  });

  test('旧 Hub 不下发 admission_status：一行都不追加，行为与从前一致', () => {
    const rows = mergeNodes([meshNode(ENTRY, 'entry')], [hubRow(ENTRY), hubRow(OTHER)], CONTEXT);
    expect(rows.map((row) => row.id)).toEqual([ENTRY]);
    expect(rows[0].admissionStatus).toBe('admitted');
    expect(rows[0].pending).toBe(false);
  });

  test('revoked 的 hub 行不会被当成待批准', () => {
    const rows = mergeNodes([], [hubRow(OTHER, { admission_status: 'revoked' })], CONTEXT);
    expect(rows).toEqual([]);
  });

  test('多条待批准按名称排序，且排在已接纳成员之后', () => {
    const rows = mergeNodes(
      [meshNode(ENTRY, 'entry')],
      [
        hubRow(ENTRY),
        hubRow(PENDING_ID, { admission_status: 'pending', name: 'zulu' }),
        hubRow(OTHER, { admission_status: 'pending', name: 'alpha' }),
      ],
      CONTEXT
    );
    expect(rows.map((row) => row.name)).toEqual(['hub-aaaa', 'alpha', 'zulu']);
  });

  test('hub 列表为 null（不可达）时不产生任何待批准行', () => {
    const rows = mergeNodes([meshNode(ENTRY, 'entry')], null, CONTEXT);
    expect(rows).toHaveLength(1);
    expect(rows[0].admissionStatus).toBeNull();
  });
});
