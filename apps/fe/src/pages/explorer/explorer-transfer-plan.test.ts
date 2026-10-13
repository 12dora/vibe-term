import { describe, expect, test } from 'bun:test';
import { FileApiError } from '@vibeterm/api-client';
import type { ExplorerTransferRequest } from '@vibeterm/panels/explorer';
import type { FileRootDto, TransferItemState } from '@vibeterm/shared';
import type { ExplorerTab } from '@vibeterm/stores';
import {
  classifyTransferEnd,
  conflictingNames,
  fileRequestErrorKey,
  moveFailureToast,
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
    error?: string
  ) => ({ state, itemStates, error });

  test('排队 / 进行中 → pending', () => {
    expect(classifyTransferEnd(view('queued'))).toEqual({ kind: 'pending' });
    expect(classifyTransferEnd(view('running', ['done', 'running']))).toEqual({ kind: 'pending' });
  });

  test('全部完成（含部分跳过）→ done', () => {
    expect(classifyTransferEnd(view('done', ['done', 'done']))).toEqual({ kind: 'done' });
    expect(classifyTransferEnd(view('done', ['done', 'skipped']))).toEqual({ kind: 'done' });
  });

  test('条目状态还没见过也按 done 算', () => {
    expect(classifyTransferEnd(view('done'))).toEqual({ kind: 'done' });
    expect(classifyTransferEnd(view('done', [undefined, 'done']))).toEqual({ kind: 'done' });
  });

  test('每一项都被跳过 → skipped', () => {
    expect(classifyTransferEnd(view('done', ['skipped', 'skipped']))).toEqual({ kind: 'skipped' });
  });

  test('任务落在 done 但有条目失败 → failed', () => {
    expect(classifyTransferEnd(view('done', ['done', 'failed'], 'permission_denied'))).toEqual({
      kind: 'failed',
      error: 'permission_denied',
    });
    expect(classifyTransferEnd(view('done', ['failed']))).toEqual({ kind: 'failed', error: null });
  });

  test('失败带错误码，取消单独归类', () => {
    expect(classifyTransferEnd(view('failed', [], 'node_unreachable'))).toEqual({
      kind: 'failed',
      error: 'node_unreachable',
    });
    expect(classifyTransferEnd(view('failed'))).toEqual({ kind: 'failed', error: null });
    expect(classifyTransferEnd(view('cancelled', ['done']))).toEqual({ kind: 'cancelled' });
  });
});
