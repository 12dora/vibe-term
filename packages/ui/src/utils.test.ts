import { describe, expect, it } from 'bun:test';
import { cn } from './utils';

describe('cn', () => {
  it('合并多个 class 并去除 falsy 值', () => {
    expect(cn('a', undefined, null, false, 'b')).toBe('a b');
  });

  it('条件对象与数组形式', () => {
    expect(cn('base', { active: true, hidden: false }, ['extra'])).toBe('base active extra');
  });

  it('tailwind 冲突类后者覆盖前者', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('非冲突的 tailwind 类全部保留', () => {
    expect(cn('p-2', 'text-sm', 'font-bold')).toBe('p-2 text-sm font-bold');
  });
});
