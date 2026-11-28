// 链接激活出口与触屏 openLinkAt：url / file 各走各的监听器，策略不允许或没有监听器时返回 false；
// GhosttyTerminalController.openLinkAt 的 disposed / disableStdin / 上报接线用真实 wasm 控制器驱动。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GhosttyTerminalController } from './terminal';
import { TerminalLinkActivation } from './terminal-link-activation';
import { LinkHoverStyle } from './terminal-link-hover';
import type { TerminalLinkHit } from './terminal-pointer-shared';
import { TEST_THEME } from './test-support/fake-dom';

type ConstructorOptions = Parameters<typeof GhosttyTerminalController.create>[0];

const EXPLICIT: TerminalLinkHit = { kind: 'url', url: 'https://e.com', explicit: true };
const DETECTED_FILE: TerminalLinkHit = { kind: 'file', path: '/repo/a.ts', explicit: false };

function harness() {
  const links = new TerminalLinkActivation();
  const urls: string[] = [];
  const files: string[] = [];
  const urlSub = links.onUrl((url) => urls.push(url));
  links.onFile((path) => files.push(path));
  return { links, urls, files, urlSub };
}

describe('TerminalLinkActivation', () => {
  test('url / file 分别派发到各自监听器，dispose 后不再收到', () => {
    const { links, urls, files, urlSub } = harness();
    links.activate(EXPLICIT);
    links.activate(DETECTED_FILE);
    expect(urls).toEqual(['https://e.com']);
    expect(files).toEqual(['/repo/a.ts']);

    urlSub.dispose();
    expect(links.activate(EXPLICIT)).toBe(false);
    expect(urls).toHaveLength(1);
  });

  test('没有任何监听器时 activate / open 返回 false', () => {
    const links = new TerminalLinkActivation();
    expect(links.activate(EXPLICIT)).toBe(false);
    expect(links.open(EXPLICIT, 'tap', false)).toBe(false);
    links.onUrl(() => {});
    expect(links.open(EXPLICIT, 'tap', false)).toBe(true);
    expect(links.open(DETECTED_FILE, 'tap', false)).toBe(false);
  });

  test('tap：上报关闭时任何链接都打开；上报开启时只开 explicit', () => {
    const { links, urls, files } = harness();
    expect(links.open(DETECTED_FILE, 'tap', false)).toBe(true);
    expect(links.open(DETECTED_FILE, 'tap', true)).toBe(false);
    expect(links.open(EXPLICIT, 'tap', true)).toBe(true);
    expect(links.open(null, 'tap', false)).toBe(false);
    expect(files).toEqual(['/repo/a.ts']);
    expect(urls).toEqual(['https://e.com']);
  });
});

describe('LinkHoverStyle', () => {
  test('光标与 title 只在变化时写入，清空时 title 置空', () => {
    const writes: string[] = [];
    const element = {
      style: {
        set cursor(value: string) {
          writes.push(`cursor=${value}`);
        },
      },
      set title(value: string) {
        writes.push(`title=${value}`);
      },
    } as unknown as HTMLElement;
    const hover = new LinkHoverStyle();
    hover.apply(element, true, 'https://e.com/full');
    hover.apply(element, true, 'https://e.com/full');
    hover.apply(element, true, null);
    hover.apply(element, false, null);
    expect(writes).toEqual(['cursor=pointer', 'title=https://e.com/full', 'title=', 'cursor=']);
  });
});

describe('GhosttyTerminalController.openLinkAt', () => {
  let previousRaf: typeof globalThis.requestAnimationFrame;
  let previousCancelRaf: typeof globalThis.cancelAnimationFrame;
  beforeEach(() => {
    previousRaf = globalThis.requestAnimationFrame;
    previousCancelRaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
  });
  afterEach(() => {
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCancelRaf;
  });

  const DETECTED: TerminalLinkHit = { kind: 'url', url: 'https://d.example', explicit: false };

  // 命中由渲染协调器给出（未挂 DOM 时没有渲染帧），这里替换成固定命中，只测 openLinkAt 自身的接线。
  async function controller(hit: TerminalLinkHit) {
    const terminal = await GhosttyTerminalController.create({
      cols: 20,
      rows: 4,
      theme: TEST_THEME,
    } as ConstructorOptions);
    const probe = terminal as unknown as { renderCoordinator: { linkAt: () => TerminalLinkHit } };
    probe.renderCoordinator.linkAt = () => hit;
    const opened: string[] = [];
    return { terminal, opened, listen: () => terminal.onLinkActivated((url) => opened.push(url)) };
  }

  test('没有监听器时返回 false（移动端照常上报 / 聚焦）', async () => {
    const { terminal } = await controller(DETECTED);
    try {
      expect(terminal.openLinkAt(1, 1, 'tap')).toBe(false);
    } finally {
      terminal.dispose();
    }
  });

  test('上报关闭打开 detected；应用开上报后 detected 交给应用、explicit 仍打开', async () => {
    const { terminal, opened, listen } = await controller(DETECTED);
    try {
      listen();
      expect(terminal.openLinkAt(1, 1, 'tap')).toBe(true);
      terminal.write('\x1b[?1000h');
      expect(terminal.isMouseReporting()).toBe(true);
      expect(terminal.openLinkAt(1, 1, 'tap')).toBe(false);
      expect(opened).toEqual(['https://d.example']);
    } finally {
      terminal.dispose();
    }

    const explicit = await controller({ ...DETECTED, explicit: true });
    try {
      explicit.listen();
      explicit.terminal.write('\x1b[?1000h');
      expect(explicit.terminal.openLinkAt(1, 1, 'tap')).toBe(true);
    } finally {
      explicit.terminal.dispose();
    }
  });

  test('只读（disableStdin）：轻点从不上报，detected 链接照样打开', async () => {
    const { terminal, opened, listen } = await controller(DETECTED);
    try {
      listen();
      terminal.write('\x1b[?1000h');
      terminal.setDisableStdin(true);
      expect(terminal.openLinkAt(1, 1, 'tap')).toBe(true);
      expect(opened).toEqual(['https://d.example']);
    } finally {
      terminal.dispose();
    }
  });

  test('dispose 之后恒返回 false，不查命中', async () => {
    const { terminal, listen } = await controller(DETECTED);
    listen();
    let lookups = 0;
    const probe = terminal as unknown as { renderCoordinator: { linkAt: () => TerminalLinkHit } };
    probe.renderCoordinator.linkAt = () => {
      lookups += 1;
      return DETECTED;
    };
    terminal.dispose();
    expect(terminal.openLinkAt(1, 1, 'tap')).toBe(false);
    expect(lookups).toBe(0);
  });
});
