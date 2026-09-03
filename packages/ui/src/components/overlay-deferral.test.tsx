// 弹层懒加载边界的行为契约：闭合态必须与实现侧逐字一致（e2e / 单测按 data-slot 定位），
// 实现到货后部件照常渲染。

import { afterAll, describe, expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { overlayLoader, setOverlaysImplImporterForTests } from '../overlay-impl-loader';
import { AlertDialog, AlertDialogHeader, AlertDialogTrigger } from './alert-dialog';
import { Dialog, DialogTrigger } from './dialog';
import { DropdownMenu, DropdownMenuTrigger } from './dropdown-menu';
import { Sheet, SheetTrigger } from './sheet';
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

// 占位 → 实现的替换会重建 DOM 节点，节点上的语义必须先在占位阶段就对齐，
// 否则冷缓存下的第一屏拿到的是一个没有 popup 语义、也不可 Tab 到的假触发器。
const attributes = (markup: string): Record<string, string> => {
  const tag = markup.slice(0, markup.indexOf('>'));
  const found: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w-]+)="([^"]*)"/g))
    found[match[1] as string] = match[2] as string;
  return found;
};

// base-ui 用它标记「点击型触发器」，只在弹层已打开时被 FloatingFocusManager 读；
// 占位阶段没有弹层，贴上它反而会让别处打开的弹层误判焦点归属。
const IMPL_ONLY_ATTRIBUTES = ['data-base-ui-click-trigger'];

const families = [
  {
    name: 'dialog',
    node: (
      <Dialog>
        <DialogTrigger className="c">开</DialogTrigger>
      </Dialog>
    ),
  },
  {
    name: 'sheet',
    node: (
      <Sheet>
        <SheetTrigger className="c">开</SheetTrigger>
      </Sheet>
    ),
  },
  {
    name: 'alert-dialog',
    node: (
      <AlertDialog>
        <AlertDialogTrigger className="c">开</AlertDialogTrigger>
      </AlertDialog>
    ),
  },
  {
    name: 'dropdown-menu',
    node: (
      <DropdownMenu>
        <DropdownMenuTrigger className="c">更多</DropdownMenuTrigger>
      </DropdownMenu>
    ),
  },
  {
    name: 'tooltip',
    node: (
      <Tooltip>
        <TooltipTrigger className="c">书房</TooltipTrigger>
      </Tooltip>
    ),
  },
];

describe('占位与实现的触发器语义对齐', () => {
  for (const family of families) {
    test(`${family.name}：实现侧的属性占位一个不少`, async () => {
      setOverlaysImplImporterForTests(null);
      await overlayLoader.load();
      const impl = attributes(renderToStaticMarkup(family.node));

      setOverlaysImplImporterForTests(pending);
      const placeholder = attributes(renderToStaticMarkup(family.node));

      expect(placeholder.id).toBeString();
      for (const [key, value] of Object.entries(impl)) {
        if (IMPL_ONLY_ATTRIBUTES.includes(key)) continue;
        // id 由 React useId 生成，两次渲染是两棵树，只比对「有没有」
        if (key === 'id') continue;
        expect([key, placeholder[key]]).toEqual([key, value]);
      }
    });
  }

  test('调用方给了 id 时，占位与实现用的是同一个', async () => {
    setOverlaysImplImporterForTests(null);
    await overlayLoader.load();
    const impl = renderToStaticMarkup(
      <Dialog>
        <DialogTrigger id="restart-trigger">开</DialogTrigger>
      </Dialog>
    );

    setOverlaysImplImporterForTests(pending);
    const placeholder = renderToStaticMarkup(
      <Dialog>
        <DialogTrigger id="restart-trigger">开</DialogTrigger>
      </Dialog>
    );

    expect(impl).toContain('id="restart-trigger"');
    expect(placeholder).toContain('id="restart-trigger"');
  });

  test('占位补上 base-ui 客户端才注入的 popup 语义', () => {
    setOverlaysImplImporterForTests(pending);
    const dialog = renderToStaticMarkup(
      <Dialog>
        <DialogTrigger>开</DialogTrigger>
      </Dialog>
    );
    const menu = renderToStaticMarkup(
      <DropdownMenu>
        <DropdownMenuTrigger>更多</DropdownMenuTrigger>
      </DropdownMenu>
    );

    expect(dialog).toContain('aria-haspopup="dialog"');
    expect(dialog).toContain('aria-expanded="false"');
    expect(menu).toContain('aria-haspopup="menu"');
  });
});
