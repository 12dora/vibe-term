// 快捷键栏位移变量的写入去重：值没变就不能碰 DOM（写自定义属性会让整棵子树样式失效），
// 换目标元素必须重新写一次，否则新挂上来的浮层会一直停在缺省值。
import { describe, expect, test } from 'bun:test';
import { ShortcutLiftWriter } from './shortcut-lift';

function fakeTarget() {
  const writes: Array<[string, string]> = [];
  const removes: string[] = [];
  return {
    writes,
    removes,
    el: {
      style: {
        setProperty: (name: string, value: string) => writes.push([name, value]),
        removeProperty: (name: string) => removes.push(name),
      },
    } as unknown as HTMLElement,
  };
}

describe('ShortcutLiftWriter', () => {
  test('取整后相同的值只写一次', () => {
    const target = fakeTarget();
    const writer = new ShortcutLiftWriter('--lift');
    writer.set(12, target.el);
    writer.set(12.4, target.el);
    writer.set(11.6, target.el);

    expect(target.writes).toEqual([['--lift', '12px']]);
    expect(writer.applied).toBe(12);
  });

  test('值变化才写', () => {
    const target = fakeTarget();
    const writer = new ShortcutLiftWriter('--lift');
    writer.set(0, target.el);
    writer.set(0, target.el);
    writer.set(8, target.el);
    writer.set(8, target.el);

    expect(target.writes).toEqual([
      ['--lift', '0px'],
      ['--lift', '8px'],
    ]);
  });

  test('换目标时清掉旧元素并重新写新元素', () => {
    const first = fakeTarget();
    const second = fakeTarget();
    const writer = new ShortcutLiftWriter('--lift');
    writer.set(10, first.el);
    writer.set(10, second.el);

    expect(first.removes).toEqual(['--lift']);
    expect(second.writes).toEqual([['--lift', '10px']]);
  });

  test('目标为 null 时只记录数值不写 DOM，并清掉上一个目标', () => {
    const target = fakeTarget();
    const writer = new ShortcutLiftWriter('--lift');
    writer.set(10, target.el);
    writer.set(0, null);

    expect(target.removes).toEqual(['--lift']);
    expect(writer.applied).toBe(0);
    expect(target.writes).toHaveLength(1);
  });

  test('dispose 移除变量并复位', () => {
    const target = fakeTarget();
    const writer = new ShortcutLiftWriter('--lift');
    writer.set(10, target.el);
    writer.dispose();

    expect(target.removes).toEqual(['--lift']);
    expect(writer.applied).toBe(0);
  });
});
