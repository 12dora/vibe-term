// SheetContent 的 keepMounted 直通：闭合态是否卸载内容由 base-ui 的 `Dialog.Portal` 决定
// （`@base-ui/react@1.2.0`：`shouldRender = mounted || keepMounted`，Popup / Backdrop 再各自
// 带 `hidden={!mounted}`）。这里锁住我们这一层的契约——默认仍是「关掉就卸载」，
// 显式 keepMounted 才留在 DOM 里，且这个开关不许漏到 Popup 的 DOM 属性上。
// 仓库无 DOM 测试环境（组件测试统一走 react-dom/server），portal 里的真实挂载取不到标记，
// 所以直接比对返回的元素树。

import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';

import { SheetContent } from './sheet-impl';

type Props = Record<string, unknown>;

function portalOf(props: Props): ReactElement<Props> {
  return SheetContent(props as never) as ReactElement<Props>;
}

/** portal 的子节点固定是 [Backdrop, Popup] */
function popupOf(props: Props): ReactElement<Props> {
  const children = portalOf(props).props.children as ReactElement<Props>[];
  return children[1] as ReactElement<Props>;
}

describe('SheetContent 的 keepMounted', () => {
  test('默认不带：闭合时 base-ui 照常卸载 portal 内容', () => {
    expect(portalOf({ children: null }).props.keepMounted).toBe(false);
  });

  test('显式打开：keepMounted 直通到 Portal', () => {
    expect(portalOf({ children: null, keepMounted: true }).props.keepMounted).toBe(true);
  });

  test('keepMounted 不落到 Popup 上（它不是合法 DOM 属性）', () => {
    expect('keepMounted' in popupOf({ children: null, keepMounted: true }).props).toBe(false);
  });

  test('inert 等无障碍属性照常透到 Popup：闭合/退场期间整棵树退出交互', () => {
    expect(popupOf({ children: null, keepMounted: true, inert: true }).props.inert).toBe(true);
    expect(popupOf({ children: null, keepMounted: true, inert: false }).props.inert).toBe(false);
  });

  test('内容仍然渲染在 Popup 里，keepMounted 不改变结构', () => {
    const popup = popupOf({ children: 'x', keepMounted: true });
    expect(popup.props['data-slot']).toBe('sheet-content');
    expect((popup.props.children as unknown[])[0]).toBe('x');
  });
});
