// bun test 无 DOM：复用 watch 的静态渲染夹具（i18n + RuntimeProvider + QueryClient）断言输出。

import { beforeAll, describe, expect, test } from 'bun:test';
import type { ShareOriginCandidate, ShareRecord } from '@tmex/shared/share';
import { renderWatch as renderPanel, setupWatchTestEnv } from '../watch/watch-test-harness';
import { ShareActiveView } from './share-active-view';
import { ShareCreateForm } from './share-create-form';
import { type ShareDraft, createShareDraft } from './share-dialog-model';

beforeAll(setupWatchTestEnv);

function draft(overrides: Partial<ShareDraft> = {}): ShareDraft {
  return {
    ...createShareDraft({ name: 'build', password: 'Ab3dEf7h', origin: 'https://a.example' }),
    ...overrides,
  };
}

const candidates: ShareOriginCandidate[] = [
  { url: 'https://a.example', kind: 'site', label: 'a.example' },
];

function createForm(props: Partial<Parameters<typeof ShareCreateForm>[0]> = {}) {
  return renderPanel(
    <ShareCreateForm
      draft={draft()}
      setField={() => undefined}
      onRegeneratePassword={() => undefined}
      candidates={candidates}
      submitting={false}
      onSubmit={() => undefined}
      {...props}
    />
  ).html;
}

function record(overrides: Partial<ShareRecord> = {}): ShareRecord {
  return {
    id: 's1',
    name: 'build',
    deviceId: 'd1',
    windowId: '@1',
    windowName: 'build',
    state: 'active',
    endReason: null,
    createdAt: 1_000_000,
    expiresAt: null,
    endedAt: null,
    origin: 'https://a.example',
    url: 'https://a.example/s/s1',
    viewers: 2,
    logBytes: 0,
    logTruncated: false,
    recordLog: true,
    ...overrides,
  };
}

describe('ShareCreateForm', () => {
  test('渲染四个字段，缺省 24 小时且不展开自定义输入', () => {
    const html = createForm();
    expect(html).toContain('data-testid="share-name"');
    expect(html).toContain('data-testid="share-duration"');
    expect(html).toContain('data-testid="share-password"');
    expect(html).toContain('data-testid="share-origin"');
    expect(html).toContain('24 hours');
    expect(html).not.toContain('data-testid="share-duration-value"');
  });

  test('选自定义才出数值与单位输入', () => {
    const html = createForm({ draft: draft({ duration: 'custom' }) });
    expect(html).toContain('data-testid="share-duration-value"');
    expect(html).toContain('data-testid="share-duration-unit"');
  });

  test('没有候选地址时给出提示并禁用创建', () => {
    const html = createForm({ candidates: [] });
    expect(html).toContain('data-testid="share-no-address"');
    expect(html).toContain('No public address is configured');
    expect(html).not.toContain('data-testid="share-origin"');
    expect(html).toContain('data-testid="share-create-submit"');
    expect(html).toMatch(/data-testid="share-create-submit"[^>]*disabled/);
  });
});

describe('ShareActiveView', () => {
  test('展示链接与在线人数，刚创建时给出明文密码', () => {
    const html = renderPanel(
      <ShareActiveView
        share={record()}
        password="Ab3dEf7h"
        stopping={false}
        onStop={() => undefined}
      />
    ).html;
    expect(html).toContain('value="https://a.example/s/s1"');
    expect(html).toContain('value="Ab3dEf7h"');
    expect(html).toContain('2 online');
    expect(html).toContain('Never expires');
    expect(html).toContain('data-testid="share-stop"');
  });

  test('已有分享只给遮罩与一次性提示，复制按钮禁用', () => {
    const html = renderPanel(
      <ShareActiveView share={record()} password={null} stopping={false} onStop={() => undefined} />
    ).html;
    expect(html).toContain('••••••••');
    expect(html).toContain('The password is shown only at creation.');
    expect(html).toMatch(/data-testid="share-active-password-copy"[^>]*disabled/);
  });

  test('限期分享展示剩余期限', () => {
    const now = 1_700_000_000_000;
    const html = renderPanel(
      <ShareActiveView
        share={record({ expiresAt: now + 3 * 86_400_000 })}
        password={null}
        stopping={false}
        onStop={() => undefined}
        now={now}
      />
    ).html;
    expect(html).toContain('3 d left');
    expect(html).not.toContain('Never expires');
  });
});
