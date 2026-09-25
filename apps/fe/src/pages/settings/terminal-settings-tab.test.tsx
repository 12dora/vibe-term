import { describe, expect, test } from 'bun:test';
import { isValidElement } from 'react';
import { MemoryLimitsSection } from './nodes/memory-limits-section';
import { memoryLimitsSlot } from './terminal-settings-tab';

describe('memoryLimitsSlot', () => {
  test('本机设置页挂内存限额表单', () => {
    const slot = memoryLimitsSlot('self');
    expect(isValidElement(slot) && slot.type === MemoryLimitsSection).toBe(true);
  });

  test('远端节点的设置页不挂：表单只读写入口网关', () => {
    expect(memoryLimitsSlot('b'.repeat(32))).toBeUndefined();
  });
});
