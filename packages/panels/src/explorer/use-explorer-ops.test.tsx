// 打开条目：目录留在管理器内，文件进预览页——预览必须压栈，浏览器后退才能回到管理器。
// 无 DOM：用 react-dom/server 渲染一个探针组件取出 ops，再直接调用 open。

import { describe, expect, test } from 'bun:test';
import { encodeFileRef } from '@vibeterm/stores';
import { renderToStaticMarkup } from 'react-dom/server';
import { dirEntry, fileEntry } from './test-fixtures';
import { type ExplorerOps, type ExplorerOpsContext, useExplorerOps } from './use-explorer-ops';

interface NavCall {
  to: string;
  opts?: { replace?: boolean };
}

function openWith(entry: ReturnType<typeof fileEntry>, appPath?: (path: string) => string) {
  const navCalls: NavCall[] = [];
  const navigated: string[] = [];
  const ctx = {
    props: { rootId: 'r1', onNavigate: (path: string) => navigated.push(path) },
    runtime: {
      host: {
        navigate: (to: string, opts?: { replace?: boolean }) => navCalls.push({ to, opts }),
        ...(appPath ? { appPath } : {}),
      },
    },
  } as unknown as ExplorerOpsContext;

  let ops: ExplorerOps | null = null;
  function Probe() {
    ops = useExplorerOps({ current: ctx });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  (ops as ExplorerOps | null)?.open(entry);
  return { navCalls, navigated };
}

describe('useExplorerOps.open', () => {
  test('文件：压栈（replace:false）进入预览页', () => {
    const { navCalls, navigated } = openWith(fileEntry('/a/b.png'));
    expect(navigated).toEqual([]);
    expect(navCalls).toEqual([
      { to: `/file/${encodeFileRef('r1', '/a/b.png')}`, opts: { replace: false } },
    ]);
  });

  test('文件：多 node 宿主的路径前缀照常加上', () => {
    const { navCalls } = openWith(fileEntry('/a/b.png'), (path) => `/n/abc${path}`);
    expect(navCalls[0]?.to).toBe(`/n/abc/file/${encodeFileRef('r1', '/a/b.png')}`);
    expect(navCalls[0]?.opts).toEqual({ replace: false });
  });

  test('目录：留在管理器内导航，不跳路由', () => {
    const { navCalls, navigated } = openWith(dirEntry('/a/sub'));
    expect(navigated).toEqual(['/a/sub']);
    expect(navCalls).toEqual([]);
  });
});
