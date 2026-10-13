import { describe, expect, test } from 'bun:test';
import { collapseCrumbs, explorerCrumbs, resolveTypedPath } from './crumb-model';

describe('explorerCrumbs', () => {
  test('根目录只有一级，标签用根的展示名', () => {
    expect(explorerCrumbs('/srv/app', 'app', '/srv/app')).toEqual([
      { label: 'app', path: '/srv/app' },
    ]);
  });

  test('根以下逐级累加绝对路径', () => {
    expect(explorerCrumbs('/srv/app', 'app', '/srv/app/src/ui')).toEqual([
      { label: 'app', path: '/srv/app' },
      { label: 'src', path: '/srv/app/src' },
      { label: 'ui', path: '/srv/app/src/ui' },
    ]);
  });

  test('根为 / 时不产生双斜杠', () => {
    expect(explorerCrumbs('/', '/', '/etc/nginx')).toEqual([
      { label: '/', path: '/' },
      { label: 'etc', path: '/etc' },
      { label: 'nginx', path: '/etc/nginx' },
    ]);
  });

  test('容忍结尾斜杠', () => {
    expect(explorerCrumbs('/srv/app/', 'app', '/srv/app/src/')).toEqual([
      { label: 'app', path: '/srv/app' },
      { label: 'src', path: '/srv/app/src' },
    ]);
  });

  test('路径不在根内（含同前缀的兄弟目录）时只剩根', () => {
    expect(explorerCrumbs('/srv/app', 'app', '/srv/application/x')).toEqual([
      { label: 'app', path: '/srv/app' },
    ]);
    expect(explorerCrumbs('/srv/app', 'app', '/etc')).toHaveLength(1);
  });
});

describe('collapseCrumbs', () => {
  const crumbs = explorerCrumbs('/r', 'r', '/r/a/b/c/d');
  const labels = (list: { label: string }[]) => list.map((crumb) => crumb.label);

  test('放得下时全部留在 head', () => {
    const result = collapseCrumbs(crumbs, 5);
    expect(labels(result.head)).toEqual(['r', 'a', 'b', 'c', 'd']);
    expect(result.hidden).toEqual([]);
    expect(result.tail).toEqual([]);
  });

  test('放不下时保留根与末尾，中间折叠', () => {
    const result = collapseCrumbs(crumbs, 3);
    expect(labels(result.head)).toEqual(['r']);
    expect(labels(result.hidden)).toEqual(['a', 'b']);
    expect(labels(result.tail)).toEqual(['c', 'd']);
  });

  test('根与当前目录永远可见', () => {
    for (const max of [2, 1, 0, -3]) {
      const result = collapseCrumbs(crumbs, max);
      expect(labels(result.head)).toEqual(['r']);
      expect(labels(result.hidden)).toEqual(['a', 'b', 'c']);
      expect(labels(result.tail)).toEqual(['d']);
    }
  });

  test('折叠前后顺序与总数不变', () => {
    for (let max = 0; max <= 6; max += 1) {
      const { head, hidden, tail } = collapseCrumbs(crumbs, max);
      expect([...head, ...hidden, ...tail]).toEqual(crumbs);
    }
  });

  test('空列表与单级列表原样返回', () => {
    expect(collapseCrumbs([], 2)).toEqual({ head: [], hidden: [], tail: [] });
    expect(collapseCrumbs(crumbs.slice(0, 1), 1).head).toHaveLength(1);
  });
});

describe('resolveTypedPath', () => {
  const root = '/srv/app';
  const current = '/srv/app/src';

  test('绝对路径在根内则规范化返回', () => {
    expect(resolveTypedPath('/srv/app/docs/', root, current)).toBe('/srv/app/docs');
    expect(resolveTypedPath('  /srv/app//src/./ui  ', root, current)).toBe('/srv/app/src/ui');
    expect(resolveTypedPath('/srv/app', root, current)).toBe('/srv/app');
  });

  test('相对路径相对当前目录解析', () => {
    expect(resolveTypedPath('ui/button', root, current)).toBe('/srv/app/src/ui/button');
    expect(resolveTypedPath('./ui', root, current)).toBe('/srv/app/src/ui');
    expect(resolveTypedPath('..', root, current)).toBe('/srv/app');
    expect(resolveTypedPath('../docs', root, current)).toBe('/srv/app/docs');
    expect(resolveTypedPath('.', root, current)).toBe('/srv/app/src');
  });

  test('越出根目录返回 null', () => {
    expect(resolveTypedPath('../..', root, current)).toBeNull();
    expect(resolveTypedPath('/etc/passwd', root, current)).toBeNull();
    expect(resolveTypedPath('/srv/app/../other', root, current)).toBeNull();
    expect(resolveTypedPath('/srv/application', root, current)).toBeNull();
  });

  test('空输入与 NUL 返回 null', () => {
    expect(resolveTypedPath('', root, current)).toBeNull();
    expect(resolveTypedPath('   ', root, current)).toBeNull();
    expect(resolveTypedPath('a\0b', root, current)).toBeNull();
  });

  test('根为 / 时任何绝对路径都有效，.. 不会越过 /', () => {
    expect(resolveTypedPath('/etc/nginx/', '/', '/')).toBe('/etc/nginx');
    expect(resolveTypedPath('../../..', '/', '/etc')).toBe('/');
    expect(resolveTypedPath('var', '/', '/')).toBe('/var');
  });
});
