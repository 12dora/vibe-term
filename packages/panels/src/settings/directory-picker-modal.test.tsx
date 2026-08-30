// 目录选择器：请求参数拼装、路径推导与状态迁移用纯函数覆盖，
// 列表渲染（文件夹图标 / 符号链接 / 隐藏目录灰显 / 空态）用 react-dom/server 静态渲染断言。

import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@tmex/api-client';
import type { BrowseDirectoryEntryDto, BrowseDirectoryResponse } from '@tmex/shared';
import { I18N_RESOURCES } from '@tmex/shared';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

import {
  DirectoryEntryList,
  createDirectoryPickerState,
  directoryBreadcrumbs,
  directoryBrowseQueryOptions,
  directoryPickerReducer,
  moveDirectoryHighlight,
  resolvePickerInitialPath,
  resolvePickerSelection,
} from './directory-picker-modal';

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function entry(
  name: string,
  extra: Partial<BrowseDirectoryEntryDto> = {}
): BrowseDirectoryEntryDto {
  return {
    name,
    path: `/home/k/${name}`,
    hidden: name.startsWith('.'),
    symlink: false,
    ...extra,
  };
}

function stubClient(response: BrowseDirectoryResponse, seen: string[]): ApiClient {
  return new ApiClient('', (url) => {
    seen.push(url);
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });
}

describe('resolvePickerInitialPath', () => {
  test('绝对路径原样带入，其余交给设备默认目录', () => {
    expect(resolvePickerInitialPath('/srv/data')).toBe('/srv/data');
    expect(resolvePickerInitialPath('  /srv/data  ')).toBe('/srv/data');
    expect(resolvePickerInitialPath('srv')).toBe('');
    expect(resolvePickerInitialPath('')).toBe('');
    expect(resolvePickerInitialPath(undefined)).toBe('');
  });
});

describe('directoryBreadcrumbs', () => {
  test('逐级展开且每级都是可跳转的绝对路径', () => {
    expect(directoryBreadcrumbs('/home/k/code')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'k', path: '/home/k' },
      { label: 'code', path: '/home/k/code' },
    ]);
  });

  test('根目录只有一级；未知目录没有面包屑', () => {
    expect(directoryBreadcrumbs('/')).toEqual([{ label: '/', path: '/' }]);
    expect(directoryBreadcrumbs('')).toEqual([]);
  });
});

describe('moveDirectoryHighlight', () => {
  test('从未高亮开始下移落到首项，上移不越界', () => {
    expect(moveDirectoryHighlight(3, -1, 1)).toBe(0);
    expect(moveDirectoryHighlight(3, 0, -1)).toBe(0);
    expect(moveDirectoryHighlight(3, 2, 1)).toBe(2);
    expect(moveDirectoryHighlight(3, 1, 1)).toBe(2);
  });

  test('空列表恒为未高亮', () => {
    expect(moveDirectoryHighlight(0, 1, 1)).toBe(-1);
  });
});

describe('directoryPickerReducer', () => {
  test('进入子目录：请求路径与输入框同步，高亮复位', () => {
    const state = { ...createDirectoryPickerState('/home/k'), highlight: 2 };
    const next = directoryPickerReducer(state, { type: 'navigate', path: '/home/k/code' });
    expect(next).toEqual({
      path: '/home/k/code',
      hidden: false,
      draft: '/home/k/code',
      highlight: -1,
    });
  });

  test('输入框回车只接受绝对路径', () => {
    const typed = directoryPickerReducer(createDirectoryPickerState('/home/k'), {
      type: 'draft',
      value: ' /srv ',
    });
    expect(directoryPickerReducer(typed, { type: 'submitDraft' }).path).toBe('/srv');

    const bad = directoryPickerReducer(typed, { type: 'draft', value: 'srv' });
    expect(directoryPickerReducer(bad, { type: 'submitDraft' })).toBe(bad);
  });

  test('切换隐藏目录保留当前路径但复位高亮', () => {
    const state = { ...createDirectoryPickerState('/home/k'), highlight: 1 };
    expect(directoryPickerReducer(state, { type: 'toggleHidden', hidden: true })).toEqual({
      path: '/home/k',
      hidden: true,
      draft: '/home/k',
      highlight: -1,
    });
  });

  test('响应回来后把规范化路径同步进输入框；已一致则不产生新对象', () => {
    const state = createDirectoryPickerState('');
    const synced = directoryPickerReducer(state, { type: 'sync', path: '/home/k' });
    expect(synced.draft).toBe('/home/k');
    // 请求路径保持原样：同一目录不因回填再取一次
    expect(synced.path).toBe('');
    expect(directoryPickerReducer(synced, { type: 'sync', path: '/home/k' })).toBe(synced);
  });

  test('单击高亮，重开弹窗回到初始态', () => {
    const highlighted = directoryPickerReducer(createDirectoryPickerState('/home/k'), {
      type: 'highlight',
      index: 1,
    });
    expect(highlighted.highlight).toBe(1);
    expect(directoryPickerReducer(highlighted, { type: 'reset', path: '/srv' })).toEqual(
      createDirectoryPickerState('/srv')
    );
  });
});

describe('resolvePickerSelection', () => {
  const entries = [entry('code'), entry('srv')];

  test('未高亮时确认当前所在目录', () => {
    expect(resolvePickerSelection(entries, -1, '/home/k')).toBe('/home/k');
  });

  test('高亮子目录时确认该子目录', () => {
    expect(resolvePickerSelection(entries, 1, '/home/k')).toBe('/home/k/srv');
  });

  test('列表刚换页、下标越界时退回当前目录', () => {
    expect(resolvePickerSelection(entries, 5, '/home/k')).toBe('/home/k');
  });
});

describe('directoryBrowseQueryOptions', () => {
  const response: BrowseDirectoryResponse = {
    path: '/home/k',
    parent: '/home',
    entries: [entry('code')],
    truncated: false,
  };

  test('默认目录不带 path，隐藏目录关闭时不带 hidden', async () => {
    const seen: string[] = [];
    const options = directoryBrowseQueryOptions({
      deviceId: 'd1',
      path: '',
      hidden: false,
      client: stubClient(response, seen),
    });
    expect(options.queryKey).toEqual(['directory-browse', 'd1', '', false]);
    await expect(options.queryFn()).resolves.toEqual(response);
    expect(seen).toEqual(['/api/files/browse?deviceId=d1']);
  });

  test('指定目录与显示隐藏目录都进 query string', async () => {
    const seen: string[] = [];
    const options = directoryBrowseQueryOptions({
      deviceId: 'd1',
      path: '/home/k',
      hidden: true,
      client: stubClient(response, seen),
    });
    expect(options.queryKey).toEqual(['directory-browse', 'd1', '/home/k', true]);
    await options.queryFn();
    expect(seen).toEqual(['/api/files/browse?deviceId=d1&path=%2Fhome%2Fk&hidden=1']);
  });

  test('错误响应抛 FileApiError（由列表的错误态兜住）', async () => {
    const client = new ApiClient('', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: '目录不存在', code: 'not_found' }), { status: 404 })
      )
    );
    const options = directoryBrowseQueryOptions({
      deviceId: 'd1',
      path: '/nope',
      hidden: false,
      client,
    });
    await expect(options.queryFn()).rejects.toThrow('目录不存在');
  });
});

function renderList(props: Parameters<typeof DirectoryEntryList>[0]): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <DirectoryEntryList {...props} />
    </I18nextProvider>
  );
}

describe('DirectoryEntryList', () => {
  test('渲染子目录，隐藏目录灰显、符号链接带标记、高亮项可断言', () => {
    const html = renderList({
      entries: [entry('code'), entry('.config'), entry('link', { symlink: true })],
      highlight: 1,
      onHighlight: () => undefined,
      onEnter: () => undefined,
    });
    expect(html).toContain('data-testid="directory-picker-entry-code"');
    expect(html).toContain('data-testid="directory-picker-entry-.config"');
    expect(html).toContain('符号链接');
    // 隐藏目录灰显
    expect(
      /data-testid="directory-picker-entry-\.config"[^>]*text-muted-foreground/.test(html)
    ).toBe(true);
    // 高亮项（.config）带 aria-current
    expect(/data-testid="directory-picker-entry-\.config"[^>]*aria-current="true"/.test(html)).toBe(
      true
    );
  });

  test('没有子目录时给空态', () => {
    const html = renderList({
      entries: [],
      highlight: -1,
      onHighlight: () => undefined,
      onEnter: () => undefined,
    });
    expect(html).toContain('没有子目录');
    expect(html).not.toContain('directory-picker-list');
  });
});
