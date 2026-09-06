// 文件侧栏空态的两个判定：单个分节的成色，与「外壳该不该出那条提示」。

import { describe, expect, test } from 'bun:test';
import { filesSectionState, shouldShowNoRootsHint } from './files-empty-hint';

const LOADING = { isError: false, isSuccess: false };
const LOADED = { isError: false, isSuccess: true };
const FAILED = { isError: true, isSuccess: false };

describe('filesSectionState', () => {
  test('目录列表还没回来是 loading，不能当成空', () => {
    expect(filesSectionState(LOADING, 0, 0)).toBe('loading');
  });

  test('加载失败算有内容：错误提示与重试按钮要挂在分节里', () => {
    expect(filesSectionState(FAILED, 0, 0)).toBe('content');
  });

  test('有可见目录就是有内容', () => {
    expect(filesSectionState(LOADED, 3, 1)).toBe('content');
  });

  test('一个目录都没配过才算未配置', () => {
    expect(filesSectionState(LOADED, 0, 0)).toBe('unconfigured');
  });

  test('配过但被侧栏开关隐藏 / 设备没连上：只是空，不劝去配置', () => {
    expect(filesSectionState(LOADED, 2, 0)).toBe('empty');
  });
});

describe('shouldShowNoRootsHint', () => {
  test('一个分节都没有（还没拿到 mesh 列表）时不出提示', () => {
    expect(shouldShowNoRootsHint([])).toBe(false);
  });

  test('还有分节在加载时不出提示，避免闪一下又消失', () => {
    expect(shouldShowNoRootsHint(['loading', 'unconfigured'])).toBe(false);
  });

  test('任一分节有内容就不出提示', () => {
    expect(shouldShowNoRootsHint(['content', 'unconfigured'])).toBe(false);
  });

  test('全空且至少一台没配过目录：出一条', () => {
    expect(shouldShowNoRootsHint(['unconfigured'])).toBe(true);
    expect(shouldShowNoRootsHint(['empty', 'unconfigured'])).toBe(true);
  });

  test('全是「配过但没得显示」时不劝去配置', () => {
    expect(shouldShowNoRootsHint(['empty', 'empty'])).toBe(false);
  });
});
