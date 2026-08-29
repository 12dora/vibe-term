// 右侧滑出面板的 URL 协议：`?panel=<name>`，其余查询参数原样保留。
// 面板本体经 Base UI 的 Portal 渲染，react-dom/server 下不产出任何标记，
// 所以这里只覆盖纯函数与 `useSidePanel` 在真实 router 上下文里算出来的链接。

import { describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { Link, MemoryRouter } = await import('react-router');
const { nextSidePanelParams, parseSidePanel, sidePanelHref } = await import('./side-panel-url');
const { useSidePanel } = await import('./use-side-panel');

describe('parseSidePanel', () => {
  test('认识的面板名原样返回', () => {
    expect(parseSidePanel('nodes')).toBe('nodes');
    expect(parseSidePanel('security')).toBe('security');
  });

  test('未知 / 缺失的值一律当没开面板，不做兜底跳转', () => {
    expect(parseSidePanel('whatever')).toBeNull();
    expect(parseSidePanel('')).toBeNull();
    expect(parseSidePanel(null)).toBeNull();
    expect(parseSidePanel(undefined)).toBeNull();
  });
});

describe('nextSidePanelParams', () => {
  test('设置面板时保留其它参数', () => {
    const next = nextSidePanelParams(new URLSearchParams('tab=nodes&q=a'), 'security');
    expect(next.get('panel')).toBe('security');
    expect(next.get('tab')).toBe('nodes');
    expect(next.get('q')).toBe('a');
  });

  test('切换面板是覆盖而不是追加', () => {
    const next = nextSidePanelParams(new URLSearchParams('panel=nodes'), 'security');
    expect(next.getAll('panel')).toEqual(['security']);
  });

  test('关闭只删 panel，其它参数不动', () => {
    const next = nextSidePanelParams(new URLSearchParams('tab=nodes&panel=nodes'), null);
    expect(next.has('panel')).toBe(false);
    expect(next.get('tab')).toBe('nodes');
  });

  test('不修改传入的参数对象', () => {
    const current = new URLSearchParams('tab=nodes');
    nextSidePanelParams(current, 'nodes');
    expect(current.has('panel')).toBe(false);
  });
});

describe('sidePanelHref', () => {
  test('只给查询串，pathname 交给 react-router 补当前页', () => {
    expect(sidePanelHref(new URLSearchParams(), 'nodes')).toBe('?panel=nodes');
    expect(sidePanelHref(new URLSearchParams('tab=x'), 'nodes')).toBe('?tab=x&panel=nodes');
  });
});

function Probe() {
  const { panel, hrefFor } = useSidePanel();
  // 用真的 <Link> 渲染：要验证的正是「只给查询串，pathname 由 router 补当前页」。
  return (
    <Link to={hrefFor('security')} data-panel={panel ?? 'none'} data-testid="probe">
      probe
    </Link>
  );
}

function renderProbe(entry: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[entry]}>
      <Probe />
    </MemoryRouter>
  );
}

describe('useSidePanel', () => {
  test('读出当前面板；链接落在当前路由上并保留其它参数', () => {
    const html = renderProbe('/n/abc/devices?tab=x&panel=nodes');
    expect(html).toContain('data-panel="nodes"');
    expect(html).toContain('href="/n/abc/devices?tab=x&amp;panel=security"');
  });

  test('没有 panel 参数时不认为有面板打开', () => {
    expect(renderProbe('/settings?tab=nodes')).toContain('data-panel="none"');
  });

  test('非法 panel 参数被忽略，链接仍然可用', () => {
    const html = renderProbe('/?panel=bogus');
    expect(html).toContain('data-panel="none"');
    expect(html).toContain('href="/?panel=security"');
  });
});
