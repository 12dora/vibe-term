import { describe, expect, test } from 'bun:test';
import { type CrumbFitMetrics, explorerCrumbs, fitCrumbs, resolveTypedPath } from './crumb-model';

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

describe('fitCrumbs', () => {
  const metrics: CrumbFitMetrics = { separator: 10, overflow: 20, minRoot: 40, minLast: 50 };
  // 根 100、三个中间级各 60、当前目录 80；全部摆开 = 360 + 4×10 = 400
  const widths = [100, 60, 60, 60, 80];
  const fit = (available: number, list: number[] = widths) => fitCrumbs(list, available, metrics);

  test('放得下时全部按自然宽度显示', () => {
    expect(fit(400)).toEqual({
      rootVisible: true,
      hidden: [],
      rootMaxWidth: null,
      lastMaxWidth: null,
    });
  });

  test('放不下时先从靠根一侧收起中间级', () => {
    // 收起 1 级：100 + 20 + 60 + 60 + 80 + 4×10 = 360
    expect(fit(399).hidden).toEqual([1]);
    expect(fit(360).hidden).toEqual([1]);
    // 收起 2 级：100 + 20 + 60 + 80 + 3×10 = 290
    expect(fit(359).hidden).toEqual([1, 2]);
    // 收起 3 级：100 + 20 + 80 + 2×10 = 220
    expect(fit(289).hidden).toEqual([1, 2, 3]);
    const collapsed = fit(220);
    expect(collapsed.rootVisible).toBe(true);
    expect(collapsed.rootMaxWidth).toBeNull();
    expect(collapsed.lastMaxWidth).toBeNull();
  });

  test('中间级收完仍放不下：压缩根，当前目录保持完整', () => {
    // 根以外占 20 + 10 + 80 + 10 = 120
    expect(fit(219)).toEqual({
      rootVisible: true,
      hidden: [1, 2, 3],
      rootMaxWidth: 99,
      lastMaxWidth: null,
    });
    expect(fit(160).rootMaxWidth).toBe(40);
  });

  test('根压到下限还放不下：根进折叠菜单，当前目录仍完整', () => {
    expect(fit(159)).toEqual({
      rootVisible: false,
      hidden: [0, 1, 2, 3],
      rootMaxWidth: null,
      lastMaxWidth: null,
    });
    // 折叠按钮 + 分隔符 + 当前目录 = 110
    expect(fit(110).lastMaxWidth).toBeNull();
  });

  test('只有当前目录自己都放不下时才截断，且不小于下限', () => {
    expect(fit(109).lastMaxWidth).toBe(79);
    expect(fit(70).lastMaxWidth).toBe(50);
    expect(fit(1).lastMaxWidth).toBe(50);
    expect(fit(1).rootVisible).toBe(false);
  });

  test('任何宽度下当前目录都不在折叠列表里', () => {
    for (let available = 1; available <= 420; available += 7) {
      const result = fit(available);
      expect(result.hidden).not.toContain(widths.length - 1);
      expect(result.hidden).toEqual([...result.hidden].sort((a, b) => a - b));
      expect(result.rootVisible).toBe(!result.hidden.includes(0));
    }
  });

  test('只有根与当前目录两级：没有中间级可收，直接压缩根', () => {
    // 实测场景：长根名 + 短目录名
    const two = [160, 40];
    expect(fit(210, two).hidden).toEqual([]);
    expect(fit(150, two)).toEqual({
      rootVisible: true,
      hidden: [],
      rootMaxWidth: 100,
      lastMaxWidth: null,
    });
    // 根只剩 39 < 40：根进菜单，折叠按钮 + 当前目录 = 70 放得下
    expect(fit(89, two)).toEqual({
      rootVisible: false,
      hidden: [0],
      rootMaxWidth: null,
      lastMaxWidth: null,
    });
  });

  test('根本身比下限还窄时按自然宽度判断', () => {
    // 根 30 < minRoot：30 + 10 + 80 = 120 放得下就不动
    expect(fit(120, [30, 80])).toEqual({
      rootVisible: true,
      hidden: [],
      rootMaxWidth: null,
      lastMaxWidth: null,
    });
    expect(fit(119, [30, 80]).rootVisible).toBe(false);
  });

  test('只有根一级时它就是当前目录', () => {
    expect(fit(100, [100]).lastMaxWidth).toBeNull();
    expect(fit(80, [100])).toEqual({
      rootVisible: true,
      hidden: [],
      rootMaxWidth: null,
      lastMaxWidth: 80,
    });
    expect(fit(10, [100]).lastMaxWidth).toBe(50);
  });

  test('尚未量到宽度或没有面包屑时不做任何折叠', () => {
    for (const available of [0, -1, Number.NaN]) {
      expect(fit(available)).toEqual({
        rootVisible: true,
        hidden: [],
        rootMaxWidth: null,
        lastMaxWidth: null,
      });
    }
    expect(fit(100, []).rootVisible).toBe(false);
    expect(fit(100, []).hidden).toEqual([]);
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
