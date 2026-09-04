// Hub chip 的候选诊断与悬浮详情：连不上的那台要能被认出来，最近一次尝试与错误都写进 title。

import { describe, expect, test } from 'bun:test';
import type { MeshHubCandidate } from '@/node/mesh-hubs';
import type { MeshHubEndpoint } from '@tmex/api-client/auth/index';
import {
  CANDIDATE_ERROR_MAX,
  candidateFailure,
  hubChipTitle,
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

describe('chip 的悬浮详情', () => {
  test('写入归属只进悬浮详情，不占 chip 正文', () => {
    expect(hubChipTitle(t, hub({ nodeId: 'h1' }), false, null, true)).toContain(
      'nodes.hubs.writer'
    );
    expect(hubChipTitle(t, hub({ nodeId: 'h1' }), false, null, false)).not.toContain(
      'nodes.hubs.writer'
    );
  });

  test('没有失败记录时只有原来那一行', () => {
    const title = hubChipTitle(t, hub({ nodeId: 'h1' }), false, null);
    expect(title).toContain('nodes.hubs.detail');
    expect(title).not.toContain('nodes.hubs.lastError');
  });

  test('有失败记录时补「最近尝试」与「最近错误」两行，错误截断', () => {
    const failure: MeshHubCandidate = {
      publicUrl: 'https://h1.example',
      lastError: 'x'.repeat(400),
      lastAttemptAt: 1700000000000,
    };
    const lines = hubChipTitle(t, hub({ nodeId: 'h1' }), false, failure).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('nodes.hubs.lastAttempt');
    expect(lines[2]).toContain('nodes.hubs.lastError');
    expect(JSON.parse(lines[2].slice(lines[2].indexOf(':') + 1)).error).toHaveLength(
      CANDIDATE_ERROR_MAX
    );
  });

  test('带授权来源时多出一行，且排在失败诊断之前', () => {
    const signed = hubChipTitle(t, hub({ nodeId: 'h1', authorization: 'signed' }), false, null);
    expect(signed.split('\n')[1]).toBe(
      'nodes.hubs.authorization.label:{"value":"nodes.hubs.authorization.signed"}'
    );
    const env = hubChipTitle(t, hub({ nodeId: 'h1', authorization: 'env' }), false, {
      publicUrl: 'https://h1.example',
      lastError: 'boom',
      lastAttemptAt: 1,
    }).split('\n');
    expect(env).toHaveLength(4);
    expect(env[1]).toContain('nodes.hubs.authorization.env');
    expect(env[2]).toContain('nodes.hubs.lastAttempt');
  });

  test('旧后端不下发 authorization：不多出这一行', () => {
    const title = hubChipTitle(t, hub({ nodeId: 'h1' }), false, null);
    expect(title).not.toContain('nodes.hubs.authorization');
  });

  test('从未尝试过的候选：时间显示为破折号', () => {
    const title = hubChipTitle(t, hub({ nodeId: 'h1' }), false, {
      publicUrl: 'https://h1.example',
      lastError: 'boom',
      lastAttemptAt: null,
    });
    expect(title).toContain('"time":"—"');
  });
});
