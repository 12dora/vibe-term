// Hub 集群条的候选诊断：连不上的那台 hub 要有警告图标，并把最近一次尝试与错误写进悬浮详情。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与本目录其余测试同一套做法）。

import { describe, expect, test } from 'bun:test';
import type { MeshHubCandidate } from '@/node/mesh-hubs';
import type { HubEndpointInfo } from '@tmex/api-client/auth/index';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CANDIDATE_ERROR_MAX,
  HubStrip,
  candidateFailure,
  hubChipTitle,
  indexCandidates,
  normalizeHubUrl,
} from './hub-strip';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

function hub(overrides: Partial<HubEndpointInfo> & { nodeId: string }): HubEndpointInfo {
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

function chipTag(html: string, nodeId: string): string {
  const at = html.indexOf(`data-testid="nodes-hub-chip-${nodeId}"`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
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

  test('从未尝试过的候选：时间显示为破折号', () => {
    const title = hubChipTitle(t, hub({ nodeId: 'h1' }), false, {
      publicUrl: 'https://h1.example',
      lastError: 'boom',
      lastAttemptAt: null,
    });
    expect(title).toContain('"time":"—"');
  });
});

describe('HubStrip', () => {
  const hubs = [hub({ nodeId: 'h1' }), hub({ nodeId: 'h2', mode: 'standby' })];

  test('连不上的那台带警告图标，别的不带', () => {
    const html = renderToStaticMarkup(
      <HubStrip
        hubs={hubs}
        attachedHubId="h1"
        writerHubId="h1"
        candidates={[
          { publicUrl: 'https://h2.example/', lastError: 'ECONNREFUSED', lastAttemptAt: 2 },
        ]}
      />
    );
    expect(html).toContain('data-testid="nodes-hub-warning-h2"');
    expect(html).not.toContain('data-testid="nodes-hub-warning-h1"');
    expect(chipTag(html, 'h2')).toContain('data-hub-failing="true"');
    expect(chipTag(html, 'h2')).toContain('nodes.hubs.lastError');
    expect(chipTag(html, 'h1')).toContain('data-hub-failing="false"');
  });

  test('旧后端不下发 candidates：与之前完全一致', () => {
    const html = renderToStaticMarkup(<HubStrip hubs={hubs} attachedHubId="h1" writerHubId="h1" />);
    expect(html).toContain('data-testid="nodes-hub-strip"');
    expect(html).not.toContain('nodes-hub-warning');
    expect(chipTag(html, 'h1')).toContain('data-hub-failing="false"');
  });

  test('只有一台 hub 时整条不渲染', () => {
    const html = renderToStaticMarkup(
      <HubStrip hubs={[hubs[0]]} attachedHubId="h1" writerHubId="h1" candidates={[]} />
    );
    expect(html).toBe('');
  });
});
