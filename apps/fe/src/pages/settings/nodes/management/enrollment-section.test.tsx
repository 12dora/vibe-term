// 待确认区块：未确认一律走中继口径；加入的步骤、结果与失败都留在行里，不只靠 toast。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 nodes-management 测试同一套做法）。

import { afterEach, describe, expect, test } from 'bun:test';
import type { PasskeyTwiceContext } from '@/auth/passkey-twice-hint';
import type { PendingEnrollment } from '@/node/enrollment';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { forgetSigner, rememberSigner } = await import('@/auth/credential-prompt');
const { resetMeshRelayStateForTest, setMeshRelayStateForTest } = await import('@/node/mesh-relay');
const { getEnrollmentEngineState, resetEnrollmentEngineState, setEnrollmentEngineStateForTest } =
  await import('@/node/enrollment-engine-state');
const { EnrollmentSection } = await import('./enrollment-section');

type EnginePatch = Parameters<typeof setEnrollmentEngineStateForTest>[0];

const PENDING: PendingEnrollment = {
  hubEnrollmentId: 'e-1',
  enrollPk: 'pk',
  authorizationBytes: 'ab',
  authorizationSig: 'sig',
  exp: Date.now() + 60_000,
  name: 'laptop',
  createdAt: Date.now(),
};

const PASSWORD_ONLY: PasskeyTwiceContext = { twoStep: true, passkeysAvailable: false };

function render(
  patch: EnginePatch = { unconfirmedIds: [PENDING.hubEnrollmentId] },
  pendings: PendingEnrollment[] = [PENDING],
  passkeyTwice: PasskeyTwiceContext = PASSWORD_ONLY
): string {
  setEnrollmentEngineStateForTest(patch);
  const passkeys = passkeyTwice.passkeysAvailable ? [{ credential_id: 'cred-1' }] : [];
  return renderToStaticMarkup(
    <EnrollmentSection
      api={{} as never}
      mode={{ uid: 'u1', kdfParams: {} } as never}
      writable
      blockedHint=""
      open={false}
      prompt={{ passkeys } as never}
      pendings={pendings}
      onConfirm={() => undefined}
      onCancel={() => undefined}
      onResendKey={() => undefined}
      twoStep={passkeyTwice.twoStep}
      engine={getEnrollmentEngineState()}
    />
  );
}

afterEach(() => {
  resetMeshRelayStateForTest();
  resetEnrollmentEngineState();
  forgetSigner();
});

describe('EnrollmentSection 的上级口径', () => {
  test('未确认一律说中继未确认', () => {
    const html = render();
    expect(html).toContain('nodes.enrollment.relayNotConfirmed');
    expect(html).not.toContain('nodes.enrollment.hubNotConfirmed');
  });

  test('已挂中继时仍是中继文案', () => {
    setMeshRelayStateForTest({
      mode: 'relay',
      relays: [{ url: 'https://relay.example', priority: 0, attached: true } as never],
    });
    const html = render();
    expect(html).toContain('nodes.enrollment.relayNotConfirmed');
    expect(html).not.toContain('nodes.enrollment.hubNotConfirmed');
  });
});

describe('加入的步骤与结果留在行里', () => {
  const progress = (phase: 'admitting' | 'distributing' | 'done' | 'keyPending' | 'expired') => ({
    'e-1': { phase, steps: 2 as const, name: 'laptop', nodeId: null },
  });

  test('第一步进行中：确认按钮标出「1/2」', () => {
    const html = render({ busyIds: ['e-1'], progressById: progress('admitting') });
    expect(html).toContain('nodes.enrollment.step.admit');
    expect(html).not.toContain('data-testid="nodes-admit-results"');
  });

  test('第二步进行中：pending 已清，结果行标出「2/2」，还不说已加入', () => {
    const html = render({ admittedIds: ['e-1'], progressById: progress('distributing') }, []);
    expect(html).toContain('data-testid="nodes-admit-result-e-1"');
    expect(html).toContain('nodes.enrollment.step.memberKey');
    expect(html).not.toContain('nodes.enrollment.admitted');
    // 进行中的不给关。
    expect(html).not.toContain('data-testid="nodes-admit-result-e-1-dismiss"');
  });

  test('加入成功：行不再凭空消失，留一条带名字、可关闭的结果', () => {
    const html = render({ admittedIds: ['e-1'], progressById: progress('done') }, []);
    expect(html).toContain('data-phase="done"');
    expect(html).toContain('nodes.enrollment.admitted');
    expect(html).toContain('laptop');
    expect(html).toContain('data-testid="nodes-admit-result-e-1-dismiss"');
    expect(html).not.toContain('data-testid="nodes-admit-result-e-1-resend"');
  });

  test('成员密钥没下发：说清节点已加入、还差哪一步，并给补发按钮', () => {
    const html = render({ admittedIds: ['e-1'], progressById: progress('keyPending') }, []);
    expect(html).toContain('nodes.enrollment.memberKeyPending');
    expect(html).toContain('data-testid="nodes-admit-result-e-1-resend"');
    expect(html).not.toContain('nodes.enrollment.admitted');
    // 用户自己取消验证的：只有那一句，不带红字原因。
    expect(html).not.toContain('data-testid="nodes-admit-result-e-1-reason"');
  });

  test('成员密钥下发失败：句后跟上翻译过的原因，不让用户盲目重试', () => {
    const failed = { 'e-1': { ...progress('keyPending')['e-1'], keyError: 'RELAY_OFFLINE' } };
    const html = render({ admittedIds: ['e-1'], progressById: failed }, []);
    expect(html).toContain('nodes.enrollment.memberKeyPending');
    expect(html).toMatch(/role="alert"[^>]*data-testid="nodes-admit-result-e-1-reason"/);
    expect(html).toContain('RELAY_OFFLINE');
    expect(html).toContain('data-testid="nodes-admit-result-e-1-resend"');
  });

  test('读屏：进度文字在 status 区里，失败提示是 alert', () => {
    const running = render({ admittedIds: ['e-1'], progressById: progress('distributing') }, []);
    expect(running).toMatch(/<output[^>]*>.*nodes\.enrollment\.step\.memberKey/);
    const failed = render({ failureById: { 'e-1': 'nodes.enrollment.admitFailed' } });
    expect(failed).toMatch(/role="alert"[^>]*data-testid="nodes-pending-failure-e-1"/);
  });

  test('加入码过期：留一条结果说要重新生成', () => {
    const html = render({ expiredIds: ['e-1'], progressById: progress('expired') }, []);
    expect(html).toContain('nodes.enrollment.expired');
  });

  test('确认失败：行内给出原因，按钮换成重试', () => {
    const html = render({ failureById: { 'e-1': 'nodes.enrollment.admitFailed' } });
    expect(html).toContain('data-testid="nodes-pending-failure-e-1"');
    expect(html).toContain('nodes.enrollment.admitFailed');
    expect(html).toContain('nodes.enrollment.retry');
    expect(html).not.toContain('nodes.enrollment.confirmPending');
  });

  test('证书判定失败同样留在行内', () => {
    const html = render({ invalidById: { 'e-1': 'nodes.enrollment.badCertSig' } });
    expect(html).toContain('data-testid="nodes-pending-failure-e-1"');
    expect(html).toContain('nodes.enrollment.badCertSig');
  });
});

describe('确认按钮旁的「通行密钥需验证两次」', () => {
  const READY: EnginePatch = { certificateReadyIds: ['e-1'] };
  const HINT = 'data-testid="nodes-pending-passkey-twice-e-1"';
  const PASSKEYS: PasskeyTwiceContext = { twoStep: true, passkeysAvailable: true };

  test('生成加入码时用过的 passkey 还在复用窗口里：不弹框也看得到这一句', () => {
    rememberSigner({ kind: 'passkey', credentialId: 'cred-1' }, Date.now());
    const html = render(READY, [PENDING], PASSWORD_ONLY);
    expect(html).toContain(HINT);
    expect(html).toContain('auth.credential.passkeyTwice');
  });

  test('窗口为空、入口有 passkey：提示；只能用密码：不提示', () => {
    expect(render(READY, [PENDING], PASSKEYS)).toContain(HINT);
    expect(render(READY, [PENDING], PASSWORD_ONLY)).not.toContain(HINT);
  });

  test('没有第二步（非中继）：不提示', () => {
    rememberSigner({ kind: 'passkey', credentialId: 'cred-1' }, Date.now());
    const html = render(READY, [PENDING], { twoStep: false, passkeysAvailable: true });
    expect(html).not.toContain(HINT);
  });

  test('未确认时只重发已签好的那条：不再说「两次」', () => {
    expect(render({ unconfirmedIds: ['e-1'] }, [PENDING], PASSKEYS)).not.toContain(HINT);
  });
});
