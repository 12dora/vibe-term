// 弹层懒加载边界的行为契约：闭合态必须与实现侧逐字一致（e2e / 单测按 data-slot 定位），
// 实现到货后部件照常渲染。

import { afterAll, describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { overlayLoader, setOverlaysImplImporterForTests } from '../overlay-impl-loader';
import { AlertDialogHeader } from './alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

const pending = () => new Promise<never>(() => undefined);

function truncatedName() {
  return (
    <Tooltip>
      <TooltipTrigger className="block truncate" title="书房" render={<div />}>
        书房
      </TooltipTrigger>
      <TooltipContent>书房</TooltipContent>
    </Tooltip>
  );
}

afterAll(() => {
  setOverlaysImplImporterForTests(null);
});

describe('实现未到货时的闭合态', () => {
  test('触发器同步渲染：标签 / data-slot / className / title 与实现侧一致', () => {
    setOverlaysImplImporterForTests(pending);
    const html = renderToStaticMarkup(truncatedName());

    expect(html.startsWith('<div')).toBe(true);
    expect(html).toContain('data-slot="tooltip-trigger"');
    expect(html).toContain('block truncate');
    expect(html).toContain('title="书房"');
    expect(html).toContain('书房');
  });

  test('气泡内容不渲染（base-ui 闭合态同样不挂 Portal/Popup）', () => {
    setOverlaysImplImporterForTests(pending);
    expect(renderToStaticMarkup(truncatedName())).not.toContain('tooltip-content');
  });

  test('弹层内部件在实现到货前渲染为空', () => {
    setOverlaysImplImporterForTests(pending);
    expect(renderToStaticMarkup(<AlertDialogHeader />)).toBe('');
  });
});

describe('实现到货后', () => {
  test('弹层内部件按实现渲染', async () => {
    setOverlaysImplImporterForTests(null);
    await overlayLoader.load();

    expect(renderToStaticMarkup(<AlertDialogHeader />)).toContain(
      'data-slot="alert-dialog-header"'
    );
  });
});
