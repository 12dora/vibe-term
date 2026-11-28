import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { createLocalDevice, waitForCanvasTerminal } from './helpers/device';
import { createSinglePaneSession, ensureCleanSession, tmux } from './helpers/tmux';

// OSC 8 超链接与单击打开：Claude Code / Codex 把 URL 输出为 OSC 8（markdown 链接只显示标签，
// 长 URL 被 TUI 硬换行成多段、每段带完整 URI）。规则：显式链接（OSC 8）单击即开，应用开着
// 鼠标上报也开；文本识别的链接在无上报时单击开，上报模式下单击交给应用、修饰键+点击才开。
// e2e 浏览器 UA 为 Windows，平台修饰键为 Control。

const EXPLICIT_URL = 'https://example.com/osc8/target?x=1';
const WRAPPED_URL = 'https://example.com/wrapped/a/very/long/path/that/the/tui/split';
const DETECTED_URL = 'https://example.com/detected';

const osc8 = (uri: string, label: string): string =>
  `\\033]8;;${uri}\\033\\\\${label}\\033]8;;\\033\\\\`;

type TextRange = { row: number; startCol: number; endCol: number };

async function findText(page: Page, needle: string): Promise<TextRange | null> {
  return page.evaluate((target) => {
    const term = (window as any).__vibetermE2eXterm;
    if (!term) return null;
    const buffer = term.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + term.rows);
    for (let y = start; y < end; y += 1) {
      const text = buffer.getLine(y)?.translateToString(false) ?? '';
      const col = text.indexOf(target);
      if (col >= 0) return { row: y - start, startCol: col, endCol: col + target.length - 1 };
    }
    return null;
  }, needle);
}

async function waitText(page: Page, needle: string): Promise<TextRange> {
  let range: TextRange | null = null;
  await expect
    .poll(
      async () => {
        range = await findText(page, needle);
        return range;
      },
      { timeout: 15_000 }
    )
    .not.toBeNull();
  if (!range) throw new Error(`text not found: ${needle}`);
  return range;
}

async function cellCenter(page: Page, row: number, col: number): Promise<{ x: number; y: number }> {
  const m = await page.evaluate(() => {
    const term = (window as any).__vibetermE2eXterm;
    const canvas = document.querySelector('.xterm canvas');
    if (!term || !(canvas instanceof HTMLCanvasElement)) return null;
    const rect = canvas.getBoundingClientRect();
    const cell = term._core?._renderService?.dimensions?.css?.cell;
    return {
      left: rect.left,
      top: rect.top,
      w: Number(cell?.width ?? 0),
      h: Number(cell?.height ?? 0),
    };
  });
  if (!m) throw new Error('canvas metrics unavailable');
  return { x: m.left + (col + 0.5) * m.w, y: m.top + (row + 0.5) * m.h };
}

async function textCenter(page: Page, needle: string): Promise<{ x: number; y: number }> {
  const range = await waitText(page, needle);
  return cellCenter(page, range.row, range.startCol + 1);
}

async function countUnderlinePixels(page: Page, range: TextRange): Promise<number> {
  return page.evaluate((target) => {
    const term = (window as any).__vibetermE2eXterm;
    const canvas = document.querySelector('.xterm canvas[data-layer="link"]');
    if (!term || !(canvas instanceof HTMLCanvasElement)) return -1;
    const context = canvas.getContext('2d');
    if (!context) return -1;
    const cell = term._core?._renderService?.dimensions?.css?.cell;
    const dpr = Math.max(1, globalThis.devicePixelRatio ?? 1);
    const w = Math.max(1, Math.round(Number(cell?.width ?? 0) * dpr));
    const h = Math.max(1, Math.round(Number(cell?.height ?? 0) * dpr));
    const data = context.getImageData(
      target.startCol * w,
      target.row * h,
      (target.endCol - target.startCol + 1) * w,
      h
    ).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
    return count;
  }, range);
}

const openedUrls = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...((window as any).__e2eOpened as string[])]);

async function stubWindowOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__e2eOpened = [];
    window.open = ((url?: string | URL) => {
      (window as any).__e2eOpened.push(String(url));
      return null;
    }) as typeof window.open;
  });
}

function writeScript(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

async function openSession(
  page: Page,
  request: Parameters<Parameters<typeof test>[1]>[0]['request'],
  tag: string
): Promise<{ sessionName: string; deviceId: string; sandbox: string }> {
  const sessionName = `vibeterm-e2e-hyperlinks-${tag}-${Date.now()}`;
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-e2e-hlink-')));
  createSinglePaneSession(sessionName);
  const deviceId = await createLocalDevice(
    request,
    sessionName,
    `e2e-hyperlinks-${tag}-${Date.now()}`
  );
  await stubWindowOpen(page);
  await page.goto(`/devices/${deviceId}`);
  await waitForCanvasTerminal(page);
  return { sessionName, deviceId, sandbox };
}

test('terminal: OSC 8 与文本链接单击即开，拖选不开，非 http 协议不可点', async ({
  page,
  request,
}) => {
  const { sessionName, deviceId, sandbox } = await openSession(page, request, 'plain');
  try {
    const script = writeScript(
      sandbox,
      'links.sh',
      [
        'clear',
        `printf '%b\\n' 'LABEL ${osc8(EXPLICIT_URL, 'Docs Label')}'`,
        `printf '%b\\n' '${osc8(WRAPPED_URL, 'FRAGONE')}'`,
        `printf '%b\\n' '  ${osc8(WRAPPED_URL, 'FRAGTWO')}'`,
        `printf '%b\\n' 'BAD ${osc8('javascript:alert(1)', 'BadScheme')}'`,
        `echo "PLAIN ${DETECTED_URL}"`,
      ].join('\n')
    );
    tmux(`send-keys -t ${sessionName} "sh ${script}" Enter`);

    const label = await waitText(page, 'Docs Label');
    await expect
      .poll(() => countUnderlinePixels(page, label), { timeout: 10_000 })
      .toBeGreaterThan(0);
    const bad = await waitText(page, 'BadScheme');
    expect(await countUnderlinePixels(page, bad)).toBe(0);

    const labelPoint = await textCenter(page, 'Docs Label');
    await page.mouse.move(labelPoint.x, labelPoint.y);
    await expect(page.locator(`.xterm [title="${EXPLICIT_URL}"]`)).toHaveCount(1);

    await page.mouse.click(labelPoint.x, labelPoint.y);
    await expect.poll(() => openedUrls(page)).toEqual([EXPLICIT_URL]);

    const fragTwo = await textCenter(page, 'FRAGTWO');
    await page.mouse.click(fragTwo.x, fragTwo.y);
    await expect.poll(() => openedUrls(page)).toEqual([EXPLICIT_URL, WRAPPED_URL]);

    const plain = await waitText(page, DETECTED_URL);
    const plainPoint = await cellCenter(page, plain.row, plain.startCol + 2);
    await page.mouse.click(plainPoint.x, plainPoint.y);
    await expect.poll(() => openedUrls(page)).toEqual([EXPLICIT_URL, WRAPPED_URL, DETECTED_URL]);

    // 从链接上拖选：只选文本，不打开。
    const dragEnd = await cellCenter(page, plain.row, plain.endCol);
    await page.mouse.move(plainPoint.x, plainPoint.y);
    await page.mouse.down();
    await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 5 });
    await page.mouse.up();

    const badPoint = await textCenter(page, 'BadScheme');
    await page.mouse.click(badPoint.x, badPoint.y);
    await page.waitForTimeout(300);
    expect(await openedUrls(page)).toEqual([EXPLICIT_URL, WRAPPED_URL, DETECTED_URL]);
  } finally {
    await request.delete(`/api/devices/${deviceId}`).catch(() => {});
    ensureCleanSession(sessionName);
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('terminal: 应用开鼠标上报时，OSC 8 单击仍开且不上报；文本链接单击上报、修饰键点击打开', async ({
  page,
  request,
}) => {
  const { sessionName, deviceId, sandbox } = await openSession(page, request, 'report');
  const log = join(sandbox, 'mouse.log');
  try {
    const app = writeScript(
      sandbox,
      'mouse_app.py',
      [
        'import os, sys, termios, tty',
        'fd = 0',
        'old = termios.tcgetattr(fd)',
        'tty.setraw(fd)',
        'w = lambda s: (sys.stdout.write(s), sys.stdout.flush())',
        "w('\\x1b[2J\\x1b[H\\x1b[?1000h\\x1b[?1006h')",
        `w('LABEL \\x1b]8;;${EXPLICIT_URL}\\x1b\\\\Docs Label\\x1b]8;;\\x1b\\\\\\r\\n')`,
        `w('PLAIN ${DETECTED_URL}\\r\\nREADY\\r\\n')`,
        `with open(${JSON.stringify(log)}, 'ab', buffering=0) as f:`,
        '    while True:',
        '        data = os.read(fd, 1024)',
        "        if not data or b'\\x03' in data:",
        '            break',
        '        f.write(data)',
        "w('\\x1b[?1000l\\x1b[?1006l')",
        'termios.tcsetattr(fd, termios.TCSADRAIN, old)',
      ].join('\n')
    );
    writeFileSync(log, '');
    tmux(`send-keys -t ${sessionName} "clear; python3 ${app}" Enter`);
    await waitText(page, 'READY');
    const reported = (): string => readFileSync(log, 'latin1');

    const labelPoint = await textCenter(page, 'Docs Label');
    await page.mouse.click(labelPoint.x, labelPoint.y);
    await expect.poll(() => openedUrls(page)).toEqual([EXPLICIT_URL]);
    await page.waitForTimeout(300);
    expect(reported()).not.toContain('\x1b[<');

    const plain = await waitText(page, DETECTED_URL);
    const plainPoint = await cellCenter(page, plain.row, plain.startCol + 2);
    await page.mouse.click(plainPoint.x, plainPoint.y);
    await expect.poll(reported, { timeout: 10_000 }).toContain('\x1b[<0;');
    expect(await openedUrls(page)).toEqual([EXPLICIT_URL]);

    await page.keyboard.down('Control');
    await page.mouse.click(plainPoint.x, plainPoint.y);
    await page.keyboard.up('Control');
    await expect.poll(() => openedUrls(page)).toEqual([EXPLICIT_URL, DETECTED_URL]);
  } finally {
    tmux(`send-keys -t ${sessionName} C-c`);
    await request.delete(`/api/devices/${deviceId}`).catch(() => {});
    ensureCleanSession(sessionName);
    rmSync(sandbox, { recursive: true, force: true });
  }
});
