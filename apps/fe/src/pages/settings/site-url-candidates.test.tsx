// 站点访问 URL 的候选地址单选组：可编辑（点选写草稿）、由 Hub 托管（只读，只标出生效地址）、
// 无候选三种形态。无 DOM 测试环境：版式用 react-dom/server 静态渲染断言。`t` 的产出在这里一概
// 不断言——同进程里别的测试文件（如 `FilePage.test.tsx`）会用 `mock.module` 把 `useTranslation`
// 换成原样返回 key 的桩，单跑与合跑的文案因此并不一致；能稳的只有结构：testId、`data-kind`、
// `data-selected` 与候选的 accessUrl。点选是回调，直接调用无 hook 的选项组件并驱动 radio 的 onChange。

import { describe, expect, test } from 'bun:test';
import type { ShareOriginCandidate } from '@vibeterm/shared/share';
import { Children, type ReactElement, type ReactNode, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SiteUrlField } from './general-fields';
import { UNLINKED_SITE_SETTINGS, createDefaultSiteSettingsDraft } from './site-settings-form';
import { SiteUrlCandidateOption, SiteUrlCandidates } from './site-url-candidates';
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
  url: 'https://vibeterm.example',
  kind: 'tunnel',
  label: 'vibeterm.example',
  accessUrl: 'https://vibeterm.example',
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

/** 静态 HTML 里第 index 颗候选的某个属性值。 */
function attrAt(html: string, attr: string, index: number): string | null {
  const pills = html.split('data-testid="settings-site-url-candidate"').slice(1);
  const pill = pills[index];
  if (pill === undefined) return null;
  return new RegExp(`${attr}="([^"]*)"`).exec(pill.slice(0, pill.indexOf('>')))?.[1] ?? null;
}

describe('SiteUrlCandidateOption', () => {
  test('点选把候选的完整访问地址回传', () => {
    const picked: string[] = [];
    const option = SiteUrlCandidateOption({
      candidate: candidate(),
      label: 'common.originKind.relay · relay.example',
      selected: false,
      onSelect: (accessUrl) => picked.push(accessUrl),
    });
    const radio = findByTestId(option, 'settings-site-url-candidate-radio');
    expect(radio).not.toBeNull();
    (radio?.props as { onChange: () => void }).onChange();
    expect(picked).toEqual(['https://relay.example/n/abc']);
  });

  test('完整地址只进 title 与 sr-only，可见文字仍是「种类 · host」', () => {
    const html = renderToStaticMarkup(
      <SiteUrlCandidateOption candidate={candidate()} label="relay · relay.example" selected />
    );
    expect(html).toContain('title="https://relay.example/n/abc"');
    expect(html).toContain('class="sr-only">https://relay.example/n/abc<');
    expect(html).toContain('<span class="truncate">relay · relay.example</span>');
    expect(html).toContain('checked=""');
  });

  test('只读形态不可点：radio 被禁用、胶囊标 aria-disabled', () => {
    const option = SiteUrlCandidateOption({
      candidate: candidate(),
      label: 'l',
      selected: false,
    });
    const pill = findByTestId(option, 'settings-site-url-candidate');
    expect((pill?.props as { 'aria-disabled'?: boolean })['aria-disabled']).toBe(true);
    const radio = findByTestId(option, 'settings-site-url-candidate-radio');
    expect((radio?.props as { disabled?: boolean }).disabled).toBe(true);
  });
});

describe('SiteUrlCandidates', () => {
  test('与当前值相同的候选照样列出，并标为选中；末尾斜杠与 host 大小写不算差异', () => {
    const html = renderToStaticMarkup(
      <SiteUrlCandidates
        candidates={[candidate(), TUNNEL]}
        currentValue="https://VIBETERM.example/"
        onSelect={() => undefined}
      />
    );
    expect(html.split('data-testid="settings-site-url-candidate"').length - 1).toBe(2);
    expect(attrAt(html, 'data-selected', 0)).toBe('false');
    expect(attrAt(html, 'data-selected', 1)).toBe('true');
  });

  test('当前值是自己敲的地址：一个都不选中', () => {
    const html = renderToStaticMarkup(
      <SiteUrlCandidates
        candidates={[candidate(), TUNNEL]}
        currentValue="https://other.example"
        onSelect={() => undefined}
      />
    );
    expect(attrAt(html, 'data-selected', 0)).toBe('false');
    expect(attrAt(html, 'data-selected', 1)).toBe('false');
  });

  test('当前值为空：一个都不选中', () => {
    const html = renderToStaticMarkup(
      <SiteUrlCandidates candidates={[candidate()]} currentValue="" onSelect={() => undefined} />
    );
    expect(attrAt(html, 'data-selected', 0)).toBe('false');
  });

  test('accessUrl 撞车的自建域名胶囊被丢掉，点选其它候选不增加', () => {
    const siteDup = candidate({
      url: 'https://relay.example/n/abc',
      kind: 'site',
      label: 'relay.example',
      accessUrl: 'https://relay.example/n/abc',
    });
    const relay = candidate();
    const origins = [siteDup, relay, TUNNEL];
    let current = siteDup.accessUrl;
    const render = () =>
      renderToStaticMarkup(
        <SiteUrlCandidates
          candidates={origins}
          currentValue={current}
          onSelect={(url) => {
            current = url;
          }}
        />
      );
    const click = (item: ShareOriginCandidate) => {
      const option = SiteUrlCandidateOption({
        candidate: item,
        label: item.label,
        selected: false,
        onSelect: (url) => {
          current = url;
        },
      });
      const radio = findByTestId(option, 'settings-site-url-candidate-radio');
      (radio?.props as { onChange: () => void }).onChange();
    };

    expect(render().split('data-kind="site"').length - 1).toBe(0);
    expect(render().split('data-testid="settings-site-url-candidate"').length - 1).toBe(2);
    click(relay);
    click(TUNNEL);
    const html = render();
    expect(html.split('data-kind="site"').length - 1).toBeLessThanOrEqual(1);
    expect(html.split('data-kind="site"').length - 1).toBe(0);
    expect(html.split('data-testid="settings-site-url-candidate"').length - 1).toBe(2);
  });
});

describe('SiteUrlField', () => {
  test('可编辑且有候选：提示 + 单选组，全部候选都在', () => {
    const html = renderToStaticMarkup(
      <SiteUrlField
        form={form({ siteAccessOrigins: [candidate(), TUNNEL] }, 'https://relay.example/n/abc')}
      />
    );

    expect(html).not.toContain('data-testid="settings-site-url-readonly"');
    expect(html).toContain('data-testid="settings-site-url-hint"');
    expect(html).toContain('data-testid="settings-site-url-candidates"');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('data-kind="relay"');
    expect(html).toContain('data-kind="tunnel"');
    // 种类前缀由 `originKindLabel` 拼，前半截是 key 还是中文取决于同进程里谁先跑；host 一定在。
    expect(html).toContain('· relay.example');
    // 完整地址只进 title / sr-only，可见文字不铺开长 URL。
    expect(html).toContain('title="https://relay.example/n/abc"');
    expect(html).not.toContain('truncate">https://');
    // 输入框里已是这条候选，于是它被标为选中。
    expect(attrAt(html, 'data-selected', 0)).toBe('true');
    expect(attrAt(html, 'data-selected', 1)).toBe('false');
  });

  test('由 Hub 托管：只读输入 + 生效地址被标选中，整组不可点', () => {
    const html = renderToStaticMarkup(
      <SiteUrlField
        form={form({
          siteUrlEditable: false,
          effectiveSiteUrl: 'https://vibeterm.example',
          siteAccessOrigins: [TUNNEL, candidate()],
        })}
      />
    );

    expect(html).toContain('data-testid="settings-site-url-readonly"');
    expect(html).toContain('data-testid="settings-site-url-hint"');
    expect(html).toContain('data-testid="settings-site-url-candidates"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('disabled=""');
    // 生效地址也列出来，并且是选中的那颗。
    expect(html).toContain('data-kind="tunnel"');
    expect(html).toContain('data-kind="relay"');
    expect(attrAt(html, 'data-selected', 0)).toBe('true');
    expect(attrAt(html, 'data-selected', 1)).toBe('false');
  });

  test('没有候选：不出列表', () => {
    const html = renderToStaticMarkup(<SiteUrlField form={form({})} />);

    expect(html).toContain('data-testid="settings-site-url-hint"');
    expect(html).not.toContain('data-testid="settings-site-url-candidates"');
  });
});
