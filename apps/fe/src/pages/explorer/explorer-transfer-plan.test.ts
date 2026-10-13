import { describe, expect, test } from 'bun:test';
import { FileApiError } from '@vibeterm/api-client';
import type { ExplorerTransferRequest } from '@vibeterm/panels/explorer';
import type { FileRootDto, TransferItemState } from '@vibeterm/shared';
import type { ExplorerClipboard, ExplorerTab } from '@vibeterm/stores';
import { explorerNodeOptions } from './explorer-nodes';
import {
  classifyTransferEnd,
  clipboardAfterCut,
  clipboardTouchedByMove,
  conflictingNames,
  fileRequestErrorKey,
  moveFailureToast,
  movedSourcePaths,
  planTransfer,
  relocatedMoveItems,
  resolveCopyParams,
  tabDropDest,
  transferRequestKey,
} from './explorer-transfer-plan';

const REMOTE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';

function request(overrides: Partial<ExplorerTransferRequest> = {}): ExplorerTransferRequest {
  return {
    source: {
      nodeId: 'self',
      rootId: 'r1',
      deviceId: 'd1',
      dir: '/srv/a',
      paths: ['/srv/a/x.txt', '/srv/a/y.txt', '/srv/a/docs'],
      names: ['x.txt', 'y.txt', 'docs'],
      hasDirectory: true,
    },
    dest: { nodeId: 'self', rootId: 'r1', deviceId: 'd1', dir: '/srv/b' },
    kind: 'move',
    destNames: null,
    ...overrides,
  };
}

describe('conflictingNames', () => {
  test('目标列表未知时视为没有重名', () => {
    expect(conflictingNames(request())).toEqual([]);
  });

  test('取源名字与目标已有名字的交集，保持源顺序', () => {
    const destNames = new Set(['docs', 'x.txt', 'other']);
    expect(conflictingNames(request({ destNames }))).toEqual(['x.txt', 'docs']);
  });
});

describe('planTransfer · move', () => {
  test('没有决定时整批移动，重名即失败', () => {
    expect(planTransfer(request(), null)).toEqual({
      kind: 'move',
      body: {
        rootId: 'r1',
        paths: ['/srv/a/x.txt', '/srv/a/y.txt', '/srv/a/docs'],
        destRootId: 'r1',
        destDir: '/srv/b',
        onConflict: 'fail',
      },
    });
  });

  test('替换 → overwrite，路径不变', () => {
    const plan = planTransfer(request({ destNames: new Set(['x.txt']) }), 'replace');
    expect(plan.kind).toBe('move');
    if (plan.kind !== 'move') return;
    expect(plan.body.onConflict).toBe('overwrite');
    expect(plan.body.paths).toHaveLength(3);
  });

  test('跳过 → 去掉重名的路径，其余按 fail 移动', () => {
    const plan = planTransfer(request({ destNames: new Set(['x.txt', 'docs']) }), 'skip');
    expect(plan).toMatchObject({
      kind: 'move',
      body: { paths: ['/srv/a/y.txt'], onConflict: 'fail' },
    });
  });

  test('跳过之后一项不剩 → noop', () => {
    const destNames = new Set(['x.txt', 'y.txt', 'docs']);
    expect(planTransfer(request({ destNames }), 'skip')).toEqual({ kind: 'noop' });
  });

  test('跨 root 移动带上目标 root', () => {
    const dest = { nodeId: 'self', rootId: 'r2', deviceId: 'd1', dir: '/data' };
    expect(planTransfer(request({ dest }), null)).toMatchObject({
      kind: 'move',
      body: { rootId: 'r1', destRootId: 'r2', destDir: '/data' },
    });
  });

  test('不改入参的路径数组', () => {
    const input = request();
    const plan = planTransfer(input, null);
    if (plan.kind !== 'move') throw new Error('expected move');
    expect(plan.body.paths).not.toBe(input.source.paths);
  });
});

describe('planTransfer · copy', () => {
  const dest = { nodeId: REMOTE, rootId: 'r9', deviceId: 'd9', dir: '/data' };

  test('缺省策略是 skip，源目录作为 path', () => {
    expect(planTransfer(request({ kind: 'copy', dest }), null)).toEqual({
      kind: 'copy',
      params: {
        source: {
          nodeId: 'self',
          rootId: 'r1',
          path: '/srv/a',
          paths: ['/srv/a/x.txt', '/srv/a/y.txt', '/srv/a/docs'],
        },
        dest: { nodeId: REMOTE, rootId: 'r9', path: '/data' },
        onConflict: 'skip',
      },
    });
  });

  test('替换 → overwrite；跳过 → skip 且不裁路径（由目标节点逐文件跳过）', () => {
    const base = request({ kind: 'copy', dest, destNames: new Set(['x.txt']) });
    const replace = planTransfer(base, 'replace');
    const skip = planTransfer(base, 'skip');
    if (replace.kind !== 'copy' || skip.kind !== 'copy') throw new Error('expected copy');
    expect(replace.params.onConflict).toBe('overwrite');
    expect(skip.params.onConflict).toBe('skip');
    expect(skip.params.source.paths).toHaveLength(3);
  });

  test('没有任何路径 → noop', () => {
    const empty = request({ kind: 'copy', dest });
    empty.source = { ...empty.source, paths: [], names: [] };
    expect(planTransfer(empty, null)).toEqual({ kind: 'noop' });
  });

  test('resolveCopyParams 补上两端的 mesh id', () => {
    const plan = planTransfer(request({ kind: 'copy', dest }), null);
    if (plan.kind !== 'copy') throw new Error('expected copy');
    const params = resolveCopyParams(plan.params, 'entry-mesh', REMOTE);
    expect(params.source).toMatchObject({ nodeId: 'self', meshId: 'entry-mesh', path: '/srv/a' });
    expect(params.dest).toEqual({ nodeId: REMOTE, meshId: REMOTE, rootId: 'r9', path: '/data' });
    expect(params.onConflict).toBe('skip');
  });
});

describe('tabDropDest', () => {
  const root = (overrides: Partial<FileRootDto> = {}): FileRootDto =>
    ({
      id: 'r1',
      deviceId: 'd1',
      deviceName: 'local',
      deviceType: 'local',
      path: '/srv',
      name: 'srv',
      enabled: true,
      sortOrder: 0,
      ...overrides,
    }) as FileRootDto;
  const tab: ExplorerTab = {
    id: 't1',
    nodeId: REMOTE,
    rootId: 'r1',
    history: ['/srv', '/srv/a', '/srv/a/b'],
    index: 1,
  };

  test('目标是标签页当前目录，设备取自它的根', () => {
    expect(tabDropDest(tab, [root({ id: 'r0' }), root()])).toEqual({
      nodeId: REMOTE,
      rootId: 'r1',
      deviceId: 'd1',
      dir: '/srv/a',
    });
  });

  test('根不存在或被停用 → null', () => {
    expect(tabDropDest(tab, [root({ id: 'other' })])).toBeNull();
    expect(tabDropDest(tab, [root({ enabled: false })])).toBeNull();
  });

  test('历史下标越界 → null', () => {
    expect(tabDropDest({ ...tab, index: 9 }, [root()])).toBeNull();
  });
});

describe('transferRequestKey', () => {
  test('同一请求指纹相同，目标或种类不同则不同', () => {
    const base = request();
    expect(transferRequestKey(request())).toBe(transferRequestKey(base));
    expect(transferRequestKey(request({ kind: 'copy' }))).not.toBe(transferRequestKey(base));
    const dest = { ...base.dest, dir: '/srv/c' };
    expect(transferRequestKey(request({ dest }))).not.toBe(transferRequestKey(base));
  });

  test('重名预检结果不影响指纹', () => {
    const withNames = request({ destNames: new Set(['x.txt']) });
    expect(transferRequestKey(withNames)).toBe(transferRequestKey(request()));
  });
});

describe('moveFailureToast', () => {
  test('全部成功不弹', () => {
    expect(moveFailureToast([{ path: '/a', ok: true, dest: '/b/a' }])).toBeNull();
  });

  test('全部失败带首项原因', () => {
    expect(
      moveFailureToast([
        { path: '/a', ok: false, code: 'already_exists' },
        { path: '/b', ok: false, code: 'permission_denied' },
      ])
    ).toEqual({ key: 'files.ops.moveFailed', descriptionKey: 'files.error.already_exists' });
  });

  test('失败项没有码时落到 unknown', () => {
    expect(moveFailureToast([{ path: '/a', ok: false }])?.descriptionKey).toBe(
      'files.error.unknown'
    );
  });

  test('部分失败只报数量', () => {
    expect(
      moveFailureToast([
        { path: '/a', ok: true, dest: '/x/a' },
        { path: '/b', ok: false, code: 'already_exists' },
        { path: '/c', ok: false, code: 'not_found' },
      ])
    ).toEqual({ key: 'files.ops.movePartial', count: 2 });
  });
});

describe('relocatedMoveItems', () => {
  test('只留真正换了位置的成功项', () => {
    expect(
      relocatedMoveItems([
        { path: '/a/x', ok: true, dest: '/b/x' },
        { path: '/a/y', ok: true, dest: '/a/y' },
        { path: '/a/z', ok: false, code: 'already_exists' },
        { path: '/a/w', ok: true },
      ])
    ).toEqual([{ from: '/a/x', to: '/b/x' }]);
  });
});

describe('fileRequestErrorKey', () => {
  test('文件业务码直接映射', () => {
    const error = new FileApiError(403, 'denied', 'permission_denied');
    expect(fileRequestErrorKey(error)).toBe('files.error.permission_denied');
  });

  test('旧节点不认识路由 → unsupported', () => {
    expect(fileRequestErrorKey(new FileApiError(404, 'route_not_found'))).toBe(
      'files.ops.unsupported'
    );
  });

  test('其它异常 → unknown', () => {
    expect(fileRequestErrorKey(new Error('boom'))).toBe('files.error.unknown');
  });
});

describe('classifyTransferEnd', () => {
  const view = (
    state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled',
    itemStates: Array<TransferItemState | undefined> = [],
    error?: string,
    transferredBytes = 10
  ) => ({
    state,
    itemStates,
    error,
    progress: { transferredBytes, totalBytes: 10, ratePerSec: 0, etaSec: null },
  });

  test('排队 / 进行中 → pending', () => {
    expect(classifyTransferEnd(view('queued'))).toEqual({ kind: 'pending' });
    expect(classifyTransferEnd(view('running', ['done', 'running']))).toEqual({ kind: 'pending' });
  });

  test('全部完成 → done，带真实完成数', () => {
    expect(classifyTransferEnd(view('done', ['done', 'done']))).toEqual({ kind: 'done', count: 2 });
  });

  test('条目状态一个都没见过 → done 但数量未知；个别没见过的按已完成算', () => {
    expect(classifyTransferEnd(view('done'))).toEqual({ kind: 'done', count: null });
    expect(classifyTransferEnd(view('done', [undefined, 'done']))).toEqual({
      kind: 'done',
      count: 2,
    });
  });

  test('部分完成、其余被跳过 → partial(skipped)，只数真正复制的', () => {
    expect(classifyTransferEnd(view('done', ['done', 'skipped']))).toEqual({
      kind: 'partial',
      count: 1,
      rest: 'skipped',
    });
  });

  test('部分完成、有条目失败 → partial(failed)，失败优先于跳过', () => {
    expect(classifyTransferEnd(view('done', ['done', 'failed']))).toEqual({
      kind: 'partial',
      count: 1,
      rest: 'failed',
    });
    expect(classifyTransferEnd(view('done', ['done', 'done', 'skipped', 'failed']))).toEqual({
      kind: 'partial',
      count: 2,
      rest: 'failed',
    });
  });

  test('整个文件夹的文件都被跳过：目录条目自己报 done，但一个字节没传 → skipped', () => {
    const folder = view('done', ['done', 'skipped', 'skipped'], undefined, 0);
    expect(classifyTransferEnd(folder)).toEqual({ kind: 'skipped' });
  });

  test('一个字节没传且有失败 → failed，不算部分完成', () => {
    expect(classifyTransferEnd(view('done', ['done', 'failed'], 'permission_denied', 0))).toEqual({
      kind: 'failed',
      error: 'permission_denied',
    });
  });

  test('没有跳过 / 失败时零字节也算完成（空文件、空目录）', () => {
    expect(classifyTransferEnd(view('done', ['done', 'done'], undefined, 0))).toEqual({
      kind: 'done',
      count: 2,
    });
  });

  test('每一项都被跳过 → skipped', () => {
    expect(classifyTransferEnd(view('done', ['skipped', 'skipped']))).toEqual({ kind: 'skipped' });
  });

  test('任务落在 done 但一项都没成、且有失败 → failed', () => {
    expect(classifyTransferEnd(view('done', ['failed', 'skipped'], 'permission_denied'))).toEqual({
      kind: 'failed',
      error: 'permission_denied',
    });
    expect(classifyTransferEnd(view('done', ['failed']))).toEqual({ kind: 'failed', error: null });
  });

  test('失败带错误码，取消单独归类', () => {
    expect(classifyTransferEnd(view('failed', ['done'], 'node_unreachable'))).toEqual({
      kind: 'failed',
      error: 'node_unreachable',
    });
    expect(classifyTransferEnd(view('failed'))).toEqual({ kind: 'failed', error: null });
    expect(classifyTransferEnd(view('cancelled', ['done']))).toEqual({ kind: 'cancelled' });
  });
});

describe('clipboardAfterCut', () => {
  const clip = (overrides: Partial<ExplorerClipboard> = {}): ExplorerClipboard => ({
    mode: 'cut',
    nodeId: 'self',
    rootId: 'r1',
    deviceId: 'd1',
    paths: ['/srv/a/x.txt', '/srv/a/y.txt', '/srv/a/docs'],
    ...overrides,
  });

  test('全部移走 → 清空', () => {
    const current = clip();
    expect(clipboardAfterCut(current, current, current.paths)).toBeNull();
  });

  test('部分移走 → 只摘掉移走的，其余还能再粘贴', () => {
    const current = clip();
    expect(clipboardAfterCut(current, current, ['/srv/a/y.txt'])).toEqual(
      clip({ paths: ['/srv/a/x.txt', '/srv/a/docs'] })
    );
  });

  test('一项都没移走 → 原样返回同一引用', () => {
    const current = clip();
    expect(clipboardAfterCut(current, current, [])).toBe(current);
    expect(clipboardAfterCut(current, current, ['/elsewhere'])).toBe(current);
  });

  test('期间换成了新的剪贴板 → 不动它', () => {
    const submitted = clip();
    const newer = clip({ paths: ['/srv/a/x.txt'] });
    expect(clipboardAfterCut(newer, submitted, submitted.paths)).toBe(newer);
    const otherRoot = clip({ rootId: 'r2' });
    expect(clipboardAfterCut(otherRoot, submitted, submitted.paths)).toBe(otherRoot);
    const copied = clip({ mode: 'copy' });
    expect(clipboardAfterCut(copied, submitted, submitted.paths)).toBe(copied);
  });

  test('内容相同但对象换过（重新剪切了同一批）仍算同一份', () => {
    const submitted = clip();
    expect(clipboardAfterCut(clip(), submitted, submitted.paths)).toBeNull();
  });

  test('期间被清空，或提交时没有剪贴板 / 不是剪切 → 原样', () => {
    const current = clip();
    expect(clipboardAfterCut(null, current, current.paths)).toBeNull();
    expect(clipboardAfterCut(current, null, current.paths)).toBe(current);
    const copied = clip({ mode: 'copy' });
    expect(clipboardAfterCut(copied, copied, copied.paths)).toBe(copied);
  });
});

describe('clipboardTouchedByMove', () => {
  const clip = (
    paths: string[],
    overrides: Partial<ExplorerClipboard> = {}
  ): ExplorerClipboard => ({
    mode: 'cut',
    nodeId: 'self',
    rootId: 'r1',
    deviceId: 'd1',
    paths,
    ...overrides,
  });

  test('剪贴板路径就是被移走的那个', () => {
    expect(clipboardTouchedByMove(clip(['/root/A/f']), 'self', 'r1', ['/root/A/f'])).toBe(true);
  });

  test('移走的是祖先目录：其下的剪贴板路径一并失效', () => {
    expect(clipboardTouchedByMove(clip(['/root/A/f']), 'self', 'r1', ['/root/A'])).toBe(true);
    expect(clipboardTouchedByMove(clip(['/root/A/sub/f']), 'self', 'r1', ['/root/A'])).toBe(true);
  });

  test('按路径段判：同前缀的兄弟不算', () => {
    expect(clipboardTouchedByMove(clip(['/a/bc']), 'self', 'r1', ['/a/b'])).toBe(false);
    expect(clipboardTouchedByMove(clip(['/a/b']), 'self', 'r1', ['/a/bc'])).toBe(false);
  });

  test('移走的是剪贴板路径的后代：不影响', () => {
    expect(clipboardTouchedByMove(clip(['/root/A']), 'self', 'r1', ['/root/A/f'])).toBe(false);
  });

  test('多条路径里有一条命中即可；复制模式同样适用', () => {
    const clipboard = clip(['/x/1', '/root/A/f'], { mode: 'copy' });
    expect(clipboardTouchedByMove(clipboard, 'self', 'r1', ['/y', '/root/A'])).toBe(true);
  });

  test('别的节点 / 别的 root / 没有剪贴板 / 没有移走任何东西 → false', () => {
    const clipboard = clip(['/root/A/f']);
    expect(clipboardTouchedByMove(clipboard, REMOTE, 'r1', ['/root/A'])).toBe(false);
    expect(clipboardTouchedByMove(clipboard, 'self', 'r2', ['/root/A'])).toBe(false);
    expect(clipboardTouchedByMove(null, 'self', 'r1', ['/root/A'])).toBe(false);
    expect(clipboardTouchedByMove(clipboard, 'self', 'r1', [])).toBe(false);
  });

  test('根目录作为被移走路径时不产生双斜杠误判', () => {
    expect(clipboardTouchedByMove(clip(['/a']), 'self', 'r1', ['/'])).toBe(true);
  });

  test('与 clipboardAfterCut 串联：部分成功的剪切粘贴保留没移走的项', () => {
    const submitted = clip(['/srv/a/x', '/srv/a/y']);
    const rest = clipboardAfterCut(submitted, submitted, ['/srv/a/x']);
    expect(rest).toEqual(clip(['/srv/a/y']));
    expect(clipboardTouchedByMove(rest, 'self', 'r1', ['/srv/a/x'])).toBe(false);
  });
});

describe('movedSourcePaths', () => {
  test('只取成功项的源路径', () => {
    expect(
      movedSourcePaths([
        { path: '/a/x', ok: true, dest: '/b/x' },
        { path: '/a/y', ok: false, code: 'already_exists' },
        { path: '/a/z', ok: true, dest: '/a/z' },
      ])
    ).toEqual(['/a/x', '/a/z']);
  });
});

describe('standalone 下的复制参数', () => {
  test('两端 meshId 都是 self（没有 mesh 桥，同节点任务按 self 报）', () => {
    // standalone 下 `/api/auth/mode` 仍可能带回本机 node id，不能漏进 meshId
    const { options } = explorerNodeOptions({
      modeLoaded: true,
      meshEnabled: false,
      entryNodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
      nodes: [],
      selfName: '本机',
      inventoryReady: true,
      inventoryLoading: false,
    });
    const self = options.find((option) => option.id === 'self');
    expect(self?.meshId).toBe('self');

    const dest = { nodeId: 'self', rootId: 'r2', deviceId: 'd2', dir: '/data' };
    const plan = planTransfer(request({ kind: 'copy', dest }), null);
    if (plan.kind !== 'copy' || !self) throw new Error('expected copy on self');
    const params = resolveCopyParams(plan.params, self.meshId, self.meshId);
    expect(params.source).toMatchObject({ nodeId: 'self', meshId: 'self', rootId: 'r1' });
    expect(params.dest).toEqual({ nodeId: 'self', meshId: 'self', rootId: 'r2', path: '/data' });
  });
});
