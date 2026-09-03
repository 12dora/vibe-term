import { describe, expect, it } from 'bun:test';
import { cn } from './utils';

describe('cn', () => {
  it('tailwind 冲突类后者覆盖前者', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('展开 clsx 支持的条件写法', () => {
    expect(cn('p-2', false && 'p-6', ['flex', { hidden: false, 'items-center': true }])).toBe(
      'p-2 flex items-center'
    );
  });

  it('跨参数解决冲突：后面的参数覆盖前面的', () => {
    expect(cn('bg-muted text-sm', 'bg-primary')).toBe('text-sm bg-primary');
  });

  it('简写覆盖细分方向，反向则两者共存', () => {
    expect(cn('px-4 py-2', 'p-6')).toBe('p-6');
    expect(cn('p-6', 'px-4')).toBe('p-6 px-4');
  });

  it('变体前缀各自独立成组', () => {
    expect(cn('p-2 hover:p-4', 'hover:p-6')).toBe('p-2 hover:p-6');
  });

  it('未识别的类名原样保留', () => {
    expect(cn('tmex-custom', 'p-2', 'p-4')).toBe('tmex-custom p-4');
  });

  it('空输入返回空串', () => {
    expect(cn()).toBe('');
    expect(cn(undefined, null, false)).toBe('');
  });
});
