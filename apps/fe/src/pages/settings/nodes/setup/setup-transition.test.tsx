// 后端只放行一条设置路径：任意一路提交成功之后，兄弟表单必须一起锁上。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与本目录其它组件测试同一套做法）。

import { describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { SetupTransitionContext, isSetupBlocked } = await import('./setup-transition');
const { JoinRelayForm } = await import('./join-relay-form');

const LOCAL_STATUS = {
  role: 'standalone',
  nodeEnv: 'test',
  direct: { supported: true, platform: 'darwin', installed: false, enabled: false, capable: false },
} as never;

function render(committedBy: string | null): string {
  return renderToStaticMarkup(
    <SetupTransitionContext.Provider value={{ committedBy, commit: () => undefined }}>
      <JoinRelayForm localStatus={LOCAL_STATUS} hostname="studio" />
    </SetupTransitionContext.Provider>
  );
}

describe('isSetupBlocked', () => {
  test('没有任何一路提交时谁都不锁', () => {
    expect(isSetupBlocked({ committedBy: null, commit: () => undefined }, 'a')).toBe(false);
  });

  test('提交成功的那条不锁自己，兄弟全锁', () => {
    const transition = { committedBy: 'a', commit: () => undefined };
    expect(isSetupBlocked(transition, 'a')).toBe(false);
    expect(isSetupBlocked(transition, 'b')).toBe(true);
  });
});

describe('兄弟表单在别处提交成功后被锁上', () => {
  test('未提交时提交按钮可用，也没有说明条', () => {
    const html = render(null);
    expect(html).not.toContain('setup-join-relay-blocked');
    expect(html).toContain('data-testid="setup-join-relay-submit"');
    expect(html).not.toContain('nodes.setup.transition.blocked');
  });

  test('别处提交成功后按钮禁用并给出说明', () => {
    const html = render('another-path');
    expect(html).toContain('setup-join-relay-blocked');
    expect(html).toContain('nodes.setup.transition.blocked');
    expect(html).toMatch(
      /data-testid="setup-join-relay-submit"[^>]*disabled|disabled[^>]*setup-join-relay-submit/
    );
  });
});
