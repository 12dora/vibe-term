// 面板根目录合成与发送按钮文案的纯逻辑。

import { describe, expect, test } from 'bun:test';
import { type FileRootDto, VIRTUAL_FS_ROOT_ID } from '@tmex/shared';
import type { DialogNodeOption } from '../dialog-nodes';
import { VIRTUAL_FS_ROOT, paneRoots, sendLabel } from './pane-roots';

const REMOTE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';

const OPTIONS: DialogNodeOption[] = [
  {
    id: 'self',
    meshId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
    name: '本机',
    online: true,
    loggedIn: true,
    isSelf: true,
    usable: true,
  },
  {
    id: REMOTE,
    meshId: REMOTE,
    name: 'mesh-node-b',
    online: true,
    loggedIn: true,
    isSelf: false,
    usable: true,
  },
];

function root(id: string, enabled: boolean): FileRootDto {
  return {
    id,
    deviceId: 'd1',
    deviceName: 'local',
    deviceType: 'local',
    path: `/srv/${id}`,
    name: id,
    enabled,
    sortOrder: 0,
  };
}

describe('paneRoots', () => {
  test('查询还没回来时不合成，避免虚拟根抢先被选上', () => {
    expect(paneRoots(undefined)).toEqual([]);
  });

  test('没有启用的根时合成文件系统根 /', () => {
    expect(paneRoots([])).toEqual([VIRTUAL_FS_ROOT]);
    expect(paneRoots([root('r1', false)])).toEqual([VIRTUAL_FS_ROOT]);
    expect(VIRTUAL_FS_ROOT).toMatchObject({ id: VIRTUAL_FS_ROOT_ID, path: '/', name: '/' });
  });

  test('有启用的根时只留启用项，不掺虚拟根', () => {
    expect(paneRoots([root('r1', true), root('r2', false)]).map((item) => item.id)).toEqual(['r1']);
  });
});

describe('sendLabel', () => {
  test('目标侧已选节点时按节点名出文案', () => {
    expect(sendLabel(OPTIONS, REMOTE, 'devices.transfer.sendToRight')).toEqual({
      key: 'devices.transfer.sendTo',
      node: 'mesh-node-b',
    });
  });

  test('目标侧未选节点时退回左右向的旧文案', () => {
    expect(sendLabel(OPTIONS, null, 'devices.transfer.sendToLeft')).toEqual({
      key: 'devices.transfer.sendToLeft',
      node: null,
    });
  });

  test('节点已不在列表里也退回旧文案', () => {
    expect(sendLabel(OPTIONS, 'gone', 'devices.transfer.sendToRight')).toEqual({
      key: 'devices.transfer.sendToRight',
      node: null,
    });
  });
});
