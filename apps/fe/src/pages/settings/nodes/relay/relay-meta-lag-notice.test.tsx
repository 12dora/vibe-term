// 「成员密钥未送达」告警条：有欠账才出，名单来自中继状态（服务端真相）。
// 无 DOM 测试环境，用 react-dom/server 静态渲染。

import { describe, expect, test } from 'bun:test';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { defaultAuthApi } from '@vibeterm/api-client/auth/index';
import type { RelayMetaKeyLaggingNode } from '@vibeterm/api-client/relay/tenant-api';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { RelayMetaLagNotice, laggingNames } = await import('./relay-meta-lag-notice');

const NODE_A = 'aa'.repeat(16);
const NODE_B = 'bb'.repeat(16);

const prompt = {
  withSigner: () => Promise.resolve(null),
  request: () => Promise.resolve(null),
  dialog: null,
} as unknown as CredentialPromptHandle;

const MODE = {
  uid: 'u1',
  rootEpoch: 2,
  kdfParams: { salt: 'x', memory_kib: 64, iterations: 1, parallelism: 1 },
};

function render(lagging: RelayMetaKeyLaggingNode[]): string {
  return renderToStaticMarkup(
    <RelayMetaLagNotice
      lagging={lagging}
      mode={MODE}
      api={defaultAuthApi}
      prompt={prompt}
      onChanged={() => undefined}
    />
  );
}

function row(nodeId: string, name: string | null): RelayMetaKeyLaggingNode {
  return { nodeId, name, since: null, admitSeq: 1 };
}

describe('RelayMetaLagNotice', () => {
  test('没有欠账时什么都不渲染', () => {
    expect(render([])).toBe('');
  });

  test('有欠账时出告警条与补发按钮', () => {
    const html = render([row(NODE_A, 'oracle-jp')]);
    expect(html).toContain('nodes-relay-meta-lagging');
    expect(html).toContain('nodes-relay-meta-lagging-action');
    expect(html).toContain('relay.tenant.metaKey.lagging.action');
  });

  test('缺 uid / kdf 参数时按钮禁用（签不出记录）', () => {
    const html = renderToStaticMarkup(
      <RelayMetaLagNotice
        lagging={[row(NODE_A, null)]}
        mode={null}
        api={defaultAuthApi}
        prompt={prompt}
        onChanged={() => undefined}
      />
    );
    expect(html).toContain('disabled');
  });

  test('没有名字的成员只显示 node id 前 8 位——整串 hex 没人读得下去', () => {
    expect(laggingNames([row(NODE_A, null), row(NODE_B, 'tokyo')])).toBe(
      `${NODE_A.slice(0, 8)}、tokyo`
    );
  });

  test('名单过长只列前三台', () => {
    const rows = [row(NODE_A, 'a'), row(NODE_B, 'b'), row(NODE_A, 'c'), row(NODE_B, 'd')];
    expect(laggingNames(rows)).toBe('a、b、c');
  });
});
