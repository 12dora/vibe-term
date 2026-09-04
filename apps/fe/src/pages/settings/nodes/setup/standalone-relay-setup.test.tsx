// 跨重启记号恢复出来的「纯中继」必须赢过默认的「中继兼节点」：`initialRole` 只在挂载时进
// `useState`，所以表单按角色换 key 强制重挂。无 DOM 测试环境，用 react-dom/server 静态渲染。

import { describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { StandaloneRelaySetup } = await import('./standalone-relay-setup');

const LOCAL_STATUS = {
  role: 'standalone',
  nodeEnv: 'test',
  direct: { supported: true, platform: 'darwin', installed: false, enabled: false, capable: false },
} as never;

function render(initialRole?: 'relay' | 'relay,node'): string {
  return renderToStaticMarkup(
    <StandaloneRelaySetup localStatus={LOCAL_STATUS} {...(initialRole ? { initialRole } : {})} />
  );
}

describe('StandaloneRelaySetup', () => {
  test('两条路都摆出来：加入已有中继在前，本机作为中继在后', () => {
    const html = render();
    expect(html).toContain('data-testid="setup-relay-choice-join"');
    expect(html).toContain('data-testid="setup-relay-choice-host"');
    expect(html.indexOf('setup-relay-choice-join')).toBeLessThan(
      html.indexOf('setup-relay-choice-host')
    );
  });

  test('默认「中继兼节点」：建账号，不出纯中继告警', () => {
    const html = render('relay,node');
    expect(html).toContain('id="setup-relay-username"');
    expect(html).not.toContain('data-testid="setup-relay-pure-notice"');
  });

  test('恢复出来的「纯中继」赢过默认值：不建账号，出纯中继告警', () => {
    const html = render('relay');
    expect(html).toContain('data-testid="setup-relay-pure-notice"');
    expect(html).not.toContain('id="setup-relay-username"');
  });
});
