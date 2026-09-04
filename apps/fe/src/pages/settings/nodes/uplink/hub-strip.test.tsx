// Hub chip 的共用零件：候选诊断的归一与匹配、主 / 备文案、授权来源文案。
// 详情文案本身由「连接详情」逐字段摆出来（见 `connection-details.test.tsx`），这里只测纯函数。

import { describe, expect, test } from 'bun:test';
import type { MeshHubEndpoint } from '@tmex/api-client/auth/index';
import {
  candidateFailure,
  hubAuthorizationText,
  hubDetailText,
  hubLabel,
  hubModeLabel,
  indexCandidates,
  normalizeHubUrl,
} from './hub-strip';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

function hub(overrides: Partial<MeshHubEndpoint> & { nodeId: string }): MeshHubEndpoint {
  return {
    publicUrl: `https://${overrides.nodeId}.example`,
    name: overrides.nodeId,
    mode: 'active',
    priority: 0,
    writerEpoch: 1,
    online: true,
    ...overrides,
  };
}

describe('候选地址的归一与匹配', () => {
  test('只差末尾斜杠的地址算同一台', () => {
    expect(normalizeHubUrl('https://a.example/')).toBe('https://a.example');
    expect(normalizeHubUrl('https://a.example///')).toBe('https://a.example');
    const byUrl = indexCandidates([
      { publicUrl: 'https://h1.example/', lastError: 'ECONNREFUSED', lastAttemptAt: 1 },
    ]);
    expect(candidateFailure(hub({ nodeId: 'h1' }), byUrl)?.lastError).toBe('ECONNREFUSED');
  });

  test('没有错误的候选不算失败', () => {
    const byUrl = indexCandidates([
      { publicUrl: 'https://h1.example', lastError: null, lastAttemptAt: 5 },
    ]);
    expect(candidateFailure(hub({ nodeId: 'h1' }), byUrl)).toBeNull();
    expect(candidateFailure(hub({ nodeId: 'h2' }), byUrl)).toBeNull();
  });
});

describe('共用文案', () => {
  test('短名优先取名字，没有名字时用 nodeId 前 8 位', () => {
    expect(hubLabel(hub({ nodeId: 'h1', name: 'hub-a' }))).toBe('hub-a');
    expect(hubLabel(hub({ nodeId: '0123456789abcdef', name: undefined }))).toBe('01234567');
  });

  test('主 / 备各有文案，旧后端不下发 mode 时退回通用的 Hub', () => {
    expect(hubModeLabel(t, 'active')).toBe('nodes.hubs.active');
    expect(hubModeLabel(t, 'standby')).toBe('nodes.hubs.standby');
    expect(hubModeLabel(t, null)).toBe('nodes.hub');
  });

  test('授权来源逐档翻译；旧后端不下发时不出这一行', () => {
    expect(hubAuthorizationText(t, hub({ nodeId: 'h1', authorization: 'signed' }))).toContain(
      'nodes.hubs.authorization.signed'
    );
    expect(hubAuthorizationText(t, hub({ nodeId: 'h1' }))).toBeNull();
  });

  test('节点表借用的详情文案仍带地址 / 优先级 / 纪元 / 在线态', () => {
    const detail = hubDetailText(t, hub({ nodeId: 'h1', online: false }), false);
    expect(detail).toContain('nodes.hubs.detail');
    expect(detail).toContain('nodes.hubs.offline');
    expect(hubDetailText(t, hub({ nodeId: 'h1' }), true)).toContain('nodes.hubs.attached');
  });
});
