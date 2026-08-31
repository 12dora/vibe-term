import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import { ensureCleanSession, tmux } from './helpers/tmux';

// 移动端触摸 → 鼠标上报（plan-01 项目 3）：TUI 开鼠标上报时
// tap=点击（press+release 同 cell）、单指拖=滚动（滚轮 64/65）、双指竖划=滚轮 64/65。
// TUI 的 press+motion+release 拖拽保留给桌面原生鼠标，触摸单指移动不再升级为 drag。
// 断言通道 = python TUI 把收到的 stdin 原样写日志（端到端字节流）。

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const ESC = String.fromCharCode(27);
const SGR_PRESS_RE = new RegExp(`${ESC}\\[<0;(\\d+);(\\d+)M`, 'g');
const SGR_RELEASE_RE = new RegExp(`${ESC}\\[<0;(\\d+);(\\d+)m`, 'g');
const SGR_MOTION_RE = new RegExp(`${ESC}\\[<32;\\d+;\\d+M`, 'g');
const SGR_WHEEL_RE = new RegExp(`${ESC}\\[<6[45];\\d+;\\d+M`, 'g');

const TUI_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/issue45-mouse-tui.py'
);

function readLog(logPath: string): string {
  try {
    return readFileSync(logPath, 'latin1');
  } catch {
    return '';
  }
}

async function waitFeButtonTracking(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const t = (window as any).__tmexE2eTerminal;
          return t?.exportModeSnapshot?.()?.mouseButton ?? false;
        }),
      { timeout: 15_000 }
    )
    .toBe(true);
}

interface TouchPoint {
  x: number;
  y: number;
}

// 合成 TouchEvent 派发（浏览器不会为合成触摸生成 compat mouse events，断言无 ghost click 干扰）。
// fingers 的每个元素是一根手指的 from/to；单指传一个元素。
async function multiTouch(
  page: Page,
  selector: string,
  fingers: Array<{ from: TouchPoint; to: TouchPoint }>,
  opts: { steps?: number; endDelayMs?: number } = {}
): Promise<void> {
  await page.evaluate(
    ({ selector, fingers, steps, endDelayMs }) => {
      const target = document.querySelector(selector);
      if (!(target instanceof HTMLElement)) {
        throw new Error(`target not found: ${selector}`);
      }
      if (typeof Touch === 'undefined' || typeof TouchEvent === 'undefined') {
        throw new Error('touch event API not available');
      }

      const createTouch = (identifier: number, x: number, y: number) =>
        new Touch({
          identifier,
          target,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
          radiusX: 1,
          radiusY: 1,
          rotationAngle: 0,
          force: 1,
        });

      const dispatch = (type: string, touches: Touch[], changed: Touch[]) => {
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches,
            targetTouches: touches,
            changedTouches: changed,
          })
        );
      };

      // 手指依次落下（第一指 → 第二指），与真实双指手势一致
      const current: Touch[] = [];
      fingers.forEach((finger, index) => {
        const touch = createTouch(index + 1, finger.from.x, finger.from.y);
        current[index] = touch;
        dispatch('touchstart', current.slice(0, index + 1), [touch]);
      });

      for (let step = 1; step <= (steps ?? 6); step += 1) {
        const ratio = step / (steps ?? 6);
        const moved = fingers.map((finger, index) =>
          createTouch(
            index + 1,
            finger.from.x + (finger.to.x - finger.from.x) * ratio,
            finger.from.y + (finger.to.y - finger.from.y) * ratio
          )
        );
        moved.forEach((touch, index) => {
          current[index] = touch;
        });
        dispatch('touchmove', [...current], [...current]);
      }

      const finish = () => {
        // 手指依次抬起
        for (let index = fingers.length - 1; index >= 0; index -= 1) {
          const touch = current[index];
          if (touch) {
            dispatch('touchend', current.slice(0, index), [touch]);
          }
        }
      };
      if (endDelayMs && endDelayMs > 0) {
        return new Promise<void>((resolveDone) => {
          setTimeout(() => {
            finish();
            resolveDone();
          }, endDelayMs);
        });
      }
      finish();
      return undefined;
    },
    { selector, fingers, steps: opts.steps ?? 6, endDelayMs: opts.endDelayMs ?? 0 }
  );
}

async function setupTuiPage(
  page: Page,
  request: APIRequestContext,
  sessionName: string,
  logPath: string
): Promise<{ deviceId: string }> {
  ensureCleanSession(sessionName);
  tmux(`new-session -d -s ${sessionName} -x 120 -y 45 "python3 ${TUI_SCRIPT} ${logPath} --alt"`);
  const paneId = tmux(`display-message -p -t ${sessionName} '#{pane_id}'`);
  const windowId = tmux(`display-message -p -t ${sessionName}:0 '#{window_id}'`);
  await expect
    .poll(() => tmux(`display-message -p -t ${paneId} '#{mouse_button_flag}'`), {
      timeout: 20_000,
    })
    .toBe('1');

  const createRes = await request.post('/api/devices', {
    data: { name: `${sessionName}-dev`, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };

  await page.goto(
    `/devices/${created.device.id}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
  );
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
  await waitFeButtonTracking(page);
  return { deviceId: created.device.id };
}

test('mobile: tap sends press+release on the same cell when reporting is on', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-mtap-${Date.now()}`;
  const logPath = `/tmp/${sessionName}.log`;
  const { deviceId } = await setupTuiPage(page, request, sessionName, logPath);

  try {
    const box = await page.locator('.xterm-screen').first().boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;

    writeFileSync(logPath, '');
    const point = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.3 };
    await multiTouch(page, '.xterm-screen', [{ from: point, to: point }], { steps: 0 });

    await expect
      .poll(() => [...readLog(logPath).matchAll(SGR_PRESS_RE)].length, { timeout: 10_000 })
      .toBe(1);
    const raw = readLog(logPath);
    const press = [...raw.matchAll(SGR_PRESS_RE)][0];
    const release = [...raw.matchAll(SGR_RELEASE_RE)][0];
    expect(release).toBeTruthy();
    // press/release 同 cell（都用起点坐标）
    expect(release?.[1]).toBe(press?.[1]);
    expect(release?.[2]).toBe(press?.[2]);
    expect([...raw.matchAll(SGR_MOTION_RE)].length).toBe(0);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('mobile: single-finger drag sends wheel events (not drag motion) when reporting is on', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-mscroll-${Date.now()}`;
  const logPath = `/tmp/${sessionName}.log`;
  const { deviceId } = await setupTuiPage(page, request, sessionName, logPath);

  try {
    const box = await page.locator('.xterm-screen').first().boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;

    writeFileSync(logPath, '');
    await multiTouch(
      page,
      '.xterm-screen',
      [
        {
          from: { x: box.x + box.width * 0.2, y: box.y + box.height * 0.3 },
          to: { x: box.x + box.width * 0.7, y: box.y + box.height * 0.6 },
        },
      ],
      { steps: 6 }
    );

    await expect
      .poll(() => [...readLog(logPath).matchAll(SGR_WHEEL_RE)].length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const raw = readLog(logPath);
    // 单指移动走滚动路径，不得产生 TUI 拖拽的 press/motion/release
    expect([...raw.matchAll(SGR_MOTION_RE)].length).toBe(0);
    expect([...raw.matchAll(SGR_PRESS_RE)].length).toBe(0);
    expect([...raw.matchAll(SGR_RELEASE_RE)].length).toBe(0);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('mobile: two-finger vertical swipe sends wheel events when reporting is on', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-mwheel-${Date.now()}`;
  const logPath = `/tmp/${sessionName}.log`;
  const { deviceId } = await setupTuiPage(page, request, sessionName, logPath);

  try {
    const box = await page.locator('.xterm-screen').first().boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;

    writeFileSync(logPath, '');
    const midX = box.x + box.width * 0.5;
    const startY = box.y + box.height * 0.7;
    const endY = box.y + box.height * 0.25;
    await multiTouch(
      page,
      '.xterm-screen',
      [
        { from: { x: midX - 30, y: startY }, to: { x: midX - 30, y: endY } },
        { from: { x: midX + 30, y: startY }, to: { x: midX + 30, y: endY } },
      ],
      { steps: 8 }
    );

    await expect
      .poll(() => [...readLog(logPath).matchAll(SGR_WHEEL_RE)].length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const raw = readLog(logPath);
    // 双指手势不得触发拖拽 press/motion
    expect([...raw.matchAll(SGR_PRESS_RE)].length).toBe(0);
    expect([...raw.matchAll(SGR_MOTION_RE)].length).toBe(0);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
