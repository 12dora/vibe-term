import { describe, expect, test } from 'bun:test';
import type { FileRootDto } from '@vibeterm/shared';
import { pruneStaleSidebarFilesVisibility } from '@vibeterm/stores';
import {
  authoritativeRootDeviceIds,
  isFileRootDeviceReachable,
  selectVisibleFileRoots,
} from './root-visibility';

const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

function root(patch: Partial<FileRootDto> & Pick<FileRootDto, 'id' | 'deviceId'>): FileRootDto {
  return {
    deviceName: 'dev',
    deviceType: 'local',
    path: `/srv/${patch.id}`,
    name: patch.id,
    enabled: true,
    sortOrder: 0,
    ...patch,
  };
}

const LOCAL = root({ id: 'r-local', deviceId: 'd-local', deviceType: 'local' });
const SSH = root({ id: 'r-ssh', deviceId: 'd-ssh', deviceType: 'ssh' });

function select(
  roots: FileRootDto[],
  options: {
    runtimeNodeId?: string;
    visibility?: Record<string, boolean>;
    deviceConnected?: Record<string, boolean | undefined>;
  } = {}
): string[] {
  return selectVisibleFileRoots({
    roots,
    runtimeNodeId: options.runtimeNodeId ?? 'self',
    visibility: options.visibility ?? {},
    deviceConnected: options.deviceConnected ?? {},
  }).map((item) => item.id);
}

describe('isFileRootDeviceReachable', () => {
  test('本机设备不需要显式连接', () => {
    expect(isFileRootDeviceReachable('local', 'd-local', {})).toBe(true);
  });

  test('SSH 设备连上才可达', () => {
    expect(isFileRootDeviceReachable('ssh', 'd-ssh', {})).toBe(false);
    expect(isFileRootDeviceReachable('ssh', 'd-ssh', { 'd-ssh': false })).toBe(false);
    expect(isFileRootDeviceReachable('ssh', 'd-ssh', { 'd-ssh': true })).toBe(true);
  });

  test('设备已不存在（deviceType 为 null）视为不可达', () => {
    expect(isFileRootDeviceReachable(null, 'd-gone', { 'd-gone': true })).toBe(false);
  });
});

describe('selectVisibleFileRoots', () => {
  test('默认显示：本机设备的启用目录', () => {
    expect(select([LOCAL])).toEqual(['r-local']);
  });

  test('远端 node 的目录默认不显示，开了开关才出现', () => {
    expect(select([LOCAL], { runtimeNodeId: NODE_A })).toEqual([]);
    expect(
      select([LOCAL], { runtimeNodeId: NODE_A, visibility: { [`${NODE_A}:d-local`]: true } })
    ).toEqual(['r-local']);
  });

  test('禁用的目录不显示', () => {
    expect(select([{ ...LOCAL, enabled: false }])).toEqual([]);
  });

  test('设备卡片上关掉「文件」开关后该设备的目录消失', () => {
    expect(select([LOCAL], { visibility: { 'self:d-local': false } })).toEqual([]);
    expect(
      select([LOCAL], { runtimeNodeId: NODE_A, visibility: { [`${NODE_A}:d-local`]: false } })
    ).toEqual([]);
    // 开关按 node 归属复合：别的 node 的同名 device id 不受影响（远端仍走自己的缺省=隐藏）
    expect(
      select([LOCAL], { runtimeNodeId: NODE_A, visibility: { 'self:d-local': true } })
    ).toEqual([]);
  });

  test('设备断开时它的目录消失，重连后回来', () => {
    expect(select([LOCAL, SSH])).toEqual(['r-local']);
    expect(select([LOCAL, SSH], { deviceConnected: { 'd-ssh': true } })).toEqual([
      'r-local',
      'r-ssh',
    ]);
    expect(select([LOCAL, SSH], { deviceConnected: { 'd-ssh': false } })).toEqual(['r-local']);
  });
});

describe('authoritativeRootDeviceIds', () => {
  const loaded = (roots: FileRootDto[]) => ({ data: { roots }, isSuccess: true });

  test('在线且加载成功：给出有目录的设备集合，已删除设备的目录不算', () => {
    const gone = root({ id: 'r-gone', deviceId: 'd-gone', deviceType: null });
    expect(authoritativeRootDeviceIds(loaded([LOCAL, SSH, gone]), true)).toEqual(
      new Set(['d-local', 'd-ssh'])
    );
  });

  test('离线（缓存里的旧结果）、未加载成功、占位数据：一律不给', () => {
    expect(authoritativeRootDeviceIds(loaded([LOCAL]), false)).toBeNull();
    expect(authoritativeRootDeviceIds({ isSuccess: false }, true)).toBeNull();
    expect(authoritativeRootDeviceIds({ ...loaded([LOCAL]), isSuccess: false }, true)).toBeNull();
    expect(
      authoritativeRootDeviceIds({ ...loaded([LOCAL]), isPlaceholderData: true }, true)
    ).toBeNull();
  });

  /** 设备卡片在无目录时开关显示为关且置灰，残留的 true 键只能靠这里清 */
  test('键为 true 但设备已没有目录：加载完成后清掉；离线时保留', () => {
    const map = { [`${NODE_A}:d-local`]: true, [`${NODE_A}:d-stale`]: true };
    const query = loaded([LOCAL]);

    const offlineIds = authoritativeRootDeviceIds(query, false);
    expect(offlineIds).toBeNull();

    const onlineIds = authoritativeRootDeviceIds(query, true);
    expect(onlineIds).not.toBeNull();
    expect(pruneStaleSidebarFilesVisibility(map, NODE_A, onlineIds ?? new Set())).toEqual({
      [`${NODE_A}:d-local`]: true,
    });
  });
});
