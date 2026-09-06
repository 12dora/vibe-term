// 面板可选的根目录，以及发送按钮的文案。两处都是纯函数，无 DOM 单测直接对它断言。

import { type FileRootDto, VIRTUAL_FS_ROOT_ID } from '@tmex/shared';

import type { DialogNodeOption } from '../dialog-nodes';

/**
 * 节点没有配置任何启用的文件根时，合成一个指向文件系统根的选项，让面板至少能浏览起来。
 * 后端只在「零启用根」这一种情况下认这个 id；`GET /api/files/roots` 不返回它。
 */
export const VIRTUAL_FS_ROOT: FileRootDto = {
  id: VIRTUAL_FS_ROOT_ID,
  deviceId: '',
  deviceName: null,
  deviceType: null,
  path: '/',
  name: '/',
  enabled: true,
  sortOrder: 0,
};

/** `roots` 为 undefined 表示查询还没回来：此时不合成，避免把虚拟根抢先选上。 */
export function paneRoots(roots: readonly FileRootDto[] | undefined): FileRootDto[] {
  if (!roots) return [];
  const enabled = roots.filter((root) => root.enabled);
  return enabled.length > 0 ? enabled : [VIRTUAL_FS_ROOT];
}

export interface SendLabel {
  key: string;
  node: string | null;
}

/** 目标侧已选定节点时按节点名出文案，否则退回「发送到左侧 / 右侧」。 */
export function sendLabel(
  options: readonly DialogNodeOption[],
  destNodeId: string | null,
  fallbackKey: string
): SendLabel {
  const name = options.find((option) => option.id === destNodeId)?.name;
  return name ? { key: 'devices.transfer.sendTo', node: name } : { key: fallbackKey, node: null };
}
