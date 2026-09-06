// 站点访问 URL 的候选地址列表：可编辑（可「填入」）、由 Hub 托管（只读，只能复制）、无候选三种形态。
// 无 DOM 测试环境：版式用 react-dom/server 静态渲染断言。`t` 的产出在这里一概不断言——同进程里
// 别的测试文件（如 `FilePage.test.tsx`）会用 `mock.module` 把 `useTranslation` 换成原样返回 key
// 的桩，单跑与合跑的文案因此并不一致；能稳的只有结构：testId、`data-kind` 与候选的 accessUrl。
// 「填入」是回调，直接调用无 hook 的行组件并驱动它的 onClick。

import { describe, expect, test } from 'bun:test';
import type { ShareOriginCandidate } from '@vibeterm/shared/share';
import { Children, type ReactElement, type ReactNode, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SiteUrlField } from './general-fields';
import { UNLINKED_SITE_SETTINGS, createDefaultSiteSettingsDraft } from './site-settings-form';
import { SiteUrlCandidateRow, visibleSiteUrlCandidates } from './site-url-candidates';
import type { SiteSettingsForm } from './use-site-settings-form';

function candidate(overrides: Partial<ShareOriginCandidate> = {}): ShareOriginCandidate {
  return {
    url: 'https://relay.example',
    kind: 'relay',
    label: 'relay.example',
    accessUrl: 'https://relay.example/n/abc',
    ...overrides,
  };
}

const TUNNEL = candidate({
  url: 'https://tmex.example',
  kind: 'tunnel',
  label: 'tmex.example',
  accessUrl: 'https://tmex.example',
});

function form(
  linkage: Partial<SiteSettingsForm['linkage']>,
  siteUrl = 'https://local.example'
): SiteSettingsForm {
  return {
    draft: { ...createDefaultSiteSettingsDraft(siteUrl) },
    updateDraft: () => undefined,
    save: () => undefined,
    isSaving: false,
    linkage: { ...UNLINKED_SITE_SETTINGS, ...linkage },
    canRenameNode: false,
    renameDialog: null,
    canSave: false,
  };
}

function findByTestId(node: ReactNode, testId: string): ReactElement | null {
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ children?: ReactNode; 'data-testid'?: string }>;
  if (element.props['data-testid'] === testId) return element;
  for (const child of Children.toArray(element.props.children)) {
    const found = findByTestId(child, testId);
    if (found) return found;
  }
  return null;
}

describe('visibleSiteUrlCandidates', () => {
  test('与当前值相同的候选不再列出，末尾斜杠不算差异', () => {
    const list = [candidate(), TUNNEL];
    expect(visibleSiteUrlCandidates(list, 'https://tmex.example/')).toEqual([candidate()]);
    expect(visibleSiteUrlCandidates(list, 'https://other.example')).toEqual(list);
  });
});

describe('SiteUrlCandidateRow', () => {
  test('「填入」把候选的完整访问地址回传', () => {
    const filled: string[] = [];
    const row = SiteUrlCandidateRow({
      candidate: candidate(),
      label: 'common.originKind.relay · relay.example',
      useLabel: 'use',
      testId: 'settings-site-url-candidate-0',
      onUse: (accessUrl) => filled.push(accessUrl),
    });
    const button = findByTestId(row, 'settings-site-url-candidate-use');
    expect(button).not.toBeNull();
    (button?.props as { onClick: () => void }).onClick();
    expect(filled).toEqual(['https://relay.example/n/abc']);
  });

  test('只读形态不给「填入」', () => {
    const row = SiteUrlCandidateRow({
      candidate: candidate(),
      label: 'l',
      useLabel: 'use',
      testId: 'settings-site-url-candidate-0',
    });
    expect(findByTestId(row, 'settings-site-url-candidate-use')).toBeNull();
  });
});

describe('SiteUrlField', () => {
  test('可编辑且有候选：提示 + 可用地址列表，每行给「填入」', () => {
    const html = renderToStaticMarkup(
      <SiteUrlField form={form({ siteAccessOrigins: [candidate(), TUNNEL] })} />
    );

    expect(html).not.toContain('data-testid="settings-site-url-readonly"');
    expect(html).toContain('data-testid="settings-site-url-hint"');
    expect(html).toContain('data-testid="settings-site-url-candidates"');
    expect(html).toContain('data-kind="relay"');
    expect(html).toContain('data-kind="tunnel"');
    // 种类前缀由 `originKindLabel` 拼，前半截是 key 还是中文取决于同进程里谁先跑；host 一定在。
    expect(html).toContain('· relay.example');
    expect(html).toContain('https://relay.example/n/abc');
    expect(html).toContain('https://tmex.example');
    // 「填入」在场即说明这一列走的是可编辑那一支（标题随之是「可用地址」）。
    expect(html).toContain('data-testid="settings-site-url-candidate-use"');
  });

  test('由 Hub 托管：只读输入 + 其它可用地址，只能复制，且不重复列出生效地址', () => {
    const html = renderToStaticMarkup(
      <SiteUrlField
        form={form({
          siteUrlEditable: false,
          effectiveSiteUrl: 'https://tmex.example',
          siteAccessOrigins: [TUNNEL, candidate()],
        })}
      />
    );

    expect(html).toContain('data-testid="settings-site-url-readonly"');
    expect(html).toContain('data-testid="settings-site-url-hint"');
    expect(html).toContain('data-testid="settings-site-url-candidates"');
    // 只读那一支不给「填入」（标题随之是「其它可用地址」），只留复制。
    expect(html).not.toContain('data-testid="settings-site-url-candidate-use"');
    expect(html).toContain('data-testid="settings-site-url-candidate-0-copy"');
    expect(html).toContain('data-kind="relay"');
    expect(html).not.toContain('data-kind="tunnel"');
  });

  test('没有候选：不出列表', () => {
    const html = renderToStaticMarkup(<SiteUrlField form={form({})} />);

    expect(html).toContain('data-testid="settings-site-url-hint"');
    expect(html).not.toContain('data-testid="settings-site-url-candidates"');
  });
});
