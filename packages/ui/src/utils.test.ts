import { describe, expect, it } from 'bun:test';
import { cn } from './utils';

describe('cn', () => {
  it('tailwind 冲突类后者覆盖前者', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });
});
