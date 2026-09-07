// Hub 恢复提示：候选筛选、双主判定与三种版式。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与本目录其余测试同一套做法）。
// i18n 未初始化时 `t()` 回落成 key，所以断言分两头：结构看 key，命令看**未翻译**的原文。

import { describe, expect, test } from 'bun:test';
import type { MeshHubCandidate } from '@/node/mesh-hubs';
import type { MeshHubEndpoint } from '@vibeterm/api-client/auth/index';
import zhCN from '@vibeterm/shared/i18n/locales/zh_CN.json';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HUB_CA_FINGERPRINT_COMMAND,
  HUB_DEMOTE_COMMAND,
  HubRecoveryNotices,
  HubSplitBrainBanner,
  caMismatchRows,
  hubJoinCommand,
  notAdmittedUrls,
  shortFingerprint,
  splitBrainHubs,
  trustRefreshCommand,
} from './hub-recovery';

const ADVERTISED = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PINNED = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function candidate(overrides: Partial<MeshHubCandidate> = {}): MeshHubCandidate {
  return {
    publicUrl: 'https://hub.example',
    lastError: null,
    lastAttemptAt: null,
    ...overrides,
  };
}

function hub(overrides: Partial<MeshHubEndpoint> & { nodeId: string }): MeshHubEndpoint {
  return {
    publicUrl: `https://${overrides.nodeId}.example`,
    name: overrides.nodeId,
    mode: 'active',
    priority: 0,
    writerEpoch: 3,
    online: true,
    ...overrides,
  };
}

describe('候选筛选', () => {
  test('只有带 caMismatch 的候选算证书变更，两个指纹原样带出', () => {
    const rows = caMismatchRows([
      candidate({ lastError: 'timeout' }),
      candidate({
        publicUrl: 'https://b.example',
        lastError: 'hub_ca_changed',
        caMismatch: { advertised: ADVERTISED, pinned: PINNED },
      }),
    ]);
    expect(rows).toEqual([
      { publicUrl: 'https://b.example', advertised: ADVERTISED, pinned: PINNED },
    ]);
  });

  test('hub 侧的 cert_not_admitted 与节点侧归一化后的 auth_rejected 都算未准入', () => {
    expect(
      notAdmittedUrls([
        candidate({ publicUrl: 'https://a.example', lastError: 'cert_not_admitted' }),
        candidate({ publicUrl: 'https://b.example', lastError: 'auth_rejected' }),
      ])
    ).toEqual(['https://a.example', 'https://b.example']);
  });

  test('其它失败原因不出未准入提示', () => {
    expect(
      notAdmittedUrls([
        candidate({ lastError: 'timeout' }),
        candidate({ lastError: 'dns' }),
        candidate({ lastError: null }),
      ])
    ).toEqual([]);
  });

  test('已判成 CA 变更的那一条不再重复计入未准入：TLS 都没握完，谈不上准入', () => {
    const rows = [
      candidate({
        lastError: 'hub_ca_changed',
        caMismatch: { advertised: ADVERTISED, pinned: PINNED },
      }),
    ];
    expect(notAdmittedUrls(rows)).toEqual([]);
  });
});

describe('双主判定', () => {
  test('两台 active 且纪元相同才算分叉', () => {
    const hubs = [hub({ nodeId: 'h1' }), hub({ nodeId: 'h2' })];
    expect(splitBrainHubs(hubs).map((row) => row.nodeId)).toEqual(['h1', 'h2']);
  });

  test('纪元不同是主备切换的正常形态，不报警', () => {
    expect(
      splitBrainHubs([hub({ nodeId: 'h1', writerEpoch: 3 }), hub({ nodeId: 'h2', writerEpoch: 4 })])
    ).toEqual([]);
  });

  test('备 hub 不参与判定，一台 active 也不算', () => {
    expect(splitBrainHubs([hub({ nodeId: 'h1' }), hub({ nodeId: 'h2', mode: 'standby' })])).toEqual(
      []
    );
  });

  test('多组冲突时取最大的那一组', () => {
    const hubs = [
      hub({ nodeId: 'h1', writerEpoch: 3 }),
      hub({ nodeId: 'h2', writerEpoch: 3 }),
      hub({ nodeId: 'h3', writerEpoch: 3 }),
      hub({ nodeId: 'h4', writerEpoch: 9 }),
      hub({ nodeId: 'h5', writerEpoch: 9 }),
    ];
    expect(splitBrainHubs(hubs).map((row) => row.nodeId)).toEqual(['h1', 'h2', 'h3']);
  });
});

describe('恢复命令', () => {
  test('trust refresh 代入地址与对方广播的指纹，末尾斜杠先去掉', () => {
    expect(trustRefreshCommand('https://hub.example/', ADVERTISED)).toBe(
      `vibeterm hub trust refresh https://hub.example --fingerprint ${ADVERTISED}`
    );
  });

  test('join 代入地址', () => {
    expect(hubJoinCommand('https://hub.example/')).toBe('vibeterm hub join https://hub.example');
  });

  test('指纹短形留前 16 位，短于 16 位的原样', () => {
    expect(shortFingerprint(ADVERTISED)).toBe('a1b2c3d4e5f60718…');
    expect(shortFingerprint('abc')).toBe('abc');
  });
});

describe('HubRecoveryNotices', () => {
  test('候选没问题时整块不渲染', () => {
    expect(renderToStaticMarkup(<HubRecoveryNotices candidates={[candidate()]} />)).toBe('');
  });

  test('证书变更：两个指纹都摆出来，命令已代入地址与广播指纹', () => {
    const html = renderToStaticMarkup(
      <HubRecoveryNotices
        candidates={[
          candidate({
            lastError: 'hub_ca_changed',
            caMismatch: { advertised: ADVERTISED, pinned: PINNED },
          }),
        ]}
      />
    );
    expect(html).toContain('data-testid="nodes-hub-ca-changed"');
    expect(html).toContain('nodes.hubs.caChanged.title');
    // 短形在行内、完整值在 title 与复制按钮里，两者缺一诊断就断了。
    expect(html).toContain(shortFingerprint(ADVERTISED));
    expect(html).toContain(shortFingerprint(PINNED));
    expect(html).toContain(`title="${ADVERTISED}"`);
    expect(html).toContain(`title="${PINNED}"`);
    expect(html).toContain('data-testid="nodes-hub-ca-advertised-copy"');
    expect(html).toContain('data-testid="nodes-hub-ca-pinned-copy"');
    expect(html).toContain(trustRefreshCommand('https://hub.example', ADVERTISED));
    // 核对指纹在 hub 上执行、更新 pin 在本节点执行：两条命令各自成块，各带一个复制按钮。
    expect(html).toContain(HUB_CA_FINGERPRINT_COMMAND);
    expect(html).toContain('data-testid="nodes-hub-ca-fingerprint-command-copy"');
    expect(html).toContain('data-testid="nodes-hub-ca-command-copy"');
    expect(html).not.toContain('nodes-hub-not-admitted');
  });

  test('未准入：给出重新加入的命令，不谈证书指纹', () => {
    const html = renderToStaticMarkup(
      <HubRecoveryNotices
        candidates={[candidate({ publicUrl: 'https://b.example', lastError: 'auth_rejected' })]}
      />
    );
    expect(html).toContain('data-testid="nodes-hub-not-admitted"');
    expect(html).toContain('nodes.hubs.notAdmitted.title');
    expect(html).toContain('vibeterm hub join https://b.example');
    expect(html).toContain('data-testid="nodes-hub-join-command-copy"');
    expect(html).not.toContain('nodes-hub-ca-changed');
  });
});

describe('HubSplitBrainBanner', () => {
  test('没有冲突时不渲染', () => {
    expect(renderToStaticMarkup(<HubSplitBrainBanner hubs={[hub({ nodeId: 'h1' })]} />)).toBe('');
  });

  test('两台同纪元 active：出常驻横幅与 demote 命令，且没有关闭按钮', () => {
    const html = renderToStaticMarkup(
      <HubSplitBrainBanner hubs={[hub({ nodeId: 'h1' }), hub({ nodeId: 'h2' })]} />
    );
    expect(html).toContain('data-testid="nodes-hub-split-brain"');
    expect(html).toContain('nodes.hubs.splitBrain.title');
    expect(html).toContain(HUB_DEMOTE_COMMAND);
    expect(html).toContain('data-testid="nodes-hub-demote-command-copy"');
    expect(html).not.toContain('dismiss');
  });
});

describe('文案', () => {
  test('三条提示的中文标题说清了「出了什么事」，而不是「连接失败」', () => {
    const hubs = zhCN.translation.nodes.hubs;
    expect(hubs.caChanged.title).toBe('Hub 证书已变更');
    expect(hubs.notAdmitted.title).toBe('Hub 未准入本节点（Hub 身份可能已重建）');
    expect(hubs.splitBrain.title).toBe('检测到两个活动 Hub（epoch 相同），写入可能分叉');
  });
});
