// 待确认区块的文案口径：中继模式下不能再说「Hub」。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 nodes-management 测试同一套做法）。

import { afterEach, describe, expect, test } from 'bun:test';
import type { PendingEnrollment } from '@/node/enrollment';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { resetMeshRelayStateForTest, setMeshRelayStateForTest } = await import('@/node/mesh-relay');
const { EnrollmentSection } = await import('./enrollment-section');

const PENDING: PendingEnrollment = {
  hubEnrollmentId: 'e-1',
  enrollPk: 'pk',
  authorizationBytes: 'ab',
  authorizationSig: 'sig',
  exp: Date.now() + 60_000,
  name: 'laptop',
  createdAt: Date.now(),
};

function render(): string {
  return renderToStaticMarkup(
    <EnrollmentSection
      api={{} as never}
      mode={{ uid: 'u1', kdfParams: {} } as never}
      hubApi={null}
      writable
      blockedHint=""
      writerPublicUrl={null}
      open={false}
      prompt={{} as never}
      pendings={[PENDING]}
      onConfirm={() => undefined}
      onCancel={() => undefined}
      busyIds={[]}
      hubUnconfirmedIds={[PENDING.hubEnrollmentId]}
      clearedIds={[]}
    />
  );
}

afterEach(() => {
  resetMeshRelayStateForTest();
});

describe('EnrollmentSection 的上级口径', () => {
  test('hub 模式下说「Hub 未确认」', () => {
    const html = render();
    expect(html).toContain('nodes.enrollment.hubNotConfirmed');
    expect(html).not.toContain('nodes.enrollment.relayNotConfirmed');
  });

  test('中继模式下换成中继文案', () => {
    setMeshRelayStateForTest({
      mode: 'relay',
      relays: [{ url: 'https://relay.example', priority: 0, attached: true } as never],
    });
    const html = render();
    expect(html).toContain('nodes.enrollment.relayNotConfirmed');
    expect(html).not.toContain('nodes.enrollment.hubNotConfirmed');
  });
});
