import { describe, expect, test } from 'bun:test';
import { nodeBadgeAppearance } from './node-badge';

describe('nodeBadgeAppearance', () => {
  test('在线 node 不灰显，标题同时给出名称与 id', () => {
    expect(nodeBadgeAppearance({ nodeId: 'n1', name: 'studio', online: true })).toEqual({
      label: 'studio',
      title: 'studio · n1',
      dimmed: false,
    });
  });

  test('离线 node 灰显', () => {
    expect(nodeBadgeAppearance({ nodeId: 'n1', name: 'studio', online: false }).dimmed).toBe(true);
  });

  test('名称为空白时回落到 nodeId', () => {
    expect(nodeBadgeAppearance({ nodeId: 'self', name: '   ', online: true }).label).toBe('self');
  });
});
