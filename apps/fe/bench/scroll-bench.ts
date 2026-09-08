// 终端滚动流畅度基准：对着一个运行中的 dev 实例（默认 19883 vite / 19663 gateway）派发滚轮事件，
// 统计 WebSocket 收发、首响/收敛时间、rAF 帧间隔、长任务，以及（慢速 TUI 探针时）应用侧实际滚动/丢弃行数。
// 用法（在 apps/fe 下执行，playwright 才能解析）：
//   bun run bench/scroll-bench.ts --device <deviceId> [--events 100] [--delta 16] [--gap 8] [--dir up|down]
//     [--synthetic] [--flick] [--warmDown N] [--rounds 1] [--headed] [--base http://localhost:19883]
//   mesh 拓扑：--mesh <mesh-boot state.json> --session <远端 tmux session>
// 慢速 TUI 探针：tmux -L <socket> new-session -d -s r37slow "python3 scripts/slow-mouse-tui.py 30"
// 详见 docs/development/performance-hot-paths.md「终端滚动」。
import { chromium } from 'playwright';

type Args = Record<string, string | boolean>;
const argv = process.argv.slice(2);
const args: Args = {};
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
}
const deviceId = String(args.device ?? '');
if (!deviceId && !args.mesh) throw new Error('--device required');
const events = Number(args.events ?? 60);
const delta = Number(args.delta ?? 16);
const gapMs = Number(args.gap ?? 8);
const dir = String(args.dir ?? 'up');
const rounds = Number(args.rounds ?? 1);
const base = String(args.base ?? 'http://localhost:19883');
const label = String(args.label ?? '');

const browser = await chromium.launch({ channel: 'chrome', headless: !args.headed });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
await context.addInitScript(() => {
  const w = window as any;
  const stats = {
    sent: 0,
    sentBytes: 0,
    recv: 0,
    recvBytes: 0,
    firstRecvAt: 0,
    lastRecvAt: 0,
    sentAt: [] as number[],
    recvAt: [] as number[],
    longTasks: [] as number[],
    frames: [] as number[],
    active: false,
  };
  w.__benchStats = stats;
  const OrigWS = window.WebSocket;
  const size = (d: any) => (typeof d === 'string' ? d.length : (d?.byteLength ?? d?.size ?? 0));
  const Patched: any = function (this: any, url: string, protocols?: any) {
    const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (!stats.active) return;
      const now = performance.now();
      stats.recv += 1;
      stats.recvBytes += size(ev.data);
      if (!stats.firstRecvAt) stats.firstRecvAt = now;
      stats.lastRecvAt = now;
      stats.recvAt.push(now);
    });
    return ws;
  };
  Patched.prototype = OrigWS.prototype;
  Object.defineProperties(Patched, {
    CONNECTING: { value: 0 },
    OPEN: { value: 1 },
    CLOSING: { value: 2 },
    CLOSED: { value: 3 },
  });
  const origSend = OrigWS.prototype.send;
  OrigWS.prototype.send = function (this: WebSocket, data: any) {
    if (stats.active) {
      stats.sent += 1;
      stats.sentBytes += size(data);
      stats.sentAt.push(performance.now());
    }
    return origSend.call(this, data);
  };
  (window as any).WebSocket = Patched;
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (stats.active) stats.longTasks.push(e.duration);
      }
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch {}
  const tick = (t: number) => {
    if (stats.active) stats.frames.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text());
});
let targetUrl = `${base}/devices/${deviceId}`;
if (args.mesh) {
  // mesh mode: --mesh <state.json> --session <remote tmux session>; deviceId is ignored/created
  const state = JSON.parse(await Bun.file(String(args.mesh)).text());
  const meshBase = state.baseUrl as string;
  await page.goto(`${meshBase}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('login-username').fill(state.username);
  await page.getByTestId('login-password').fill(state.password);
  await page.getByTestId('login-submit').click();
  await page.getByTestId('sidebar').waitFor({ timeout: 90_000 });
  await page.locator('a[href="/devices"]').first().click();
  await page.getByTestId('devices-page-container').waitFor({ timeout: 30_000 });
  const nodeId = state.remoteNodeId as string;
  const panel = page.getByTestId(`devices-node-panel-${nodeId}`);
  const manualLogin = page.getByTestId(`devices-node-login-${nodeId}`);
  await panel.or(manualLogin).first().waitFor({ timeout: 60_000 });
  if (await manualLogin.isVisible()) {
    await manualLogin.getByTestId(`node-login-${nodeId}`).click();
  }
  await panel.waitFor({ timeout: 30_000 });
  const session = String(args.session ?? 'r37remote');
  const res = await page.request.post(`${meshBase}/n/${nodeId}/api/devices`, {
    data: { name: `bench-${session}`, type: 'local', session, authMode: 'auto' },
  });
  if (!res.ok()) throw new Error(`create device failed ${res.status()} ${await res.text()}`);
  const created = (await res.json()) as { device: { id: string } };
  targetUrl = `${meshBase}/n/${nodeId}/devices/${created.device.id}`;
}
await page.goto(targetUrl);
await page.locator('.xterm canvas').first().waitFor({ timeout: 30_000 });
await page.waitForFunction(() => Boolean((window as any).__vibetermE2eXterm), null, {
  timeout: 30_000,
});
await page.waitForTimeout(2500);

const box = await page.locator('.xterm').first().boundingBox();
if (!box) throw new Error('no terminal box');
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(500);

const readState = () =>
  page.evaluate(() => {
    const term = (window as any).__vibetermE2eXterm;
    const b = term?.buffer?.active;
    return {
      viewportY: b?.viewportY ?? -1,
      baseY: b?.baseY ?? -1,
      length: b?.length ?? -1,
      rows: term?.rows ?? -1,
      cols: term?.cols ?? -1,
      line0: b?.getLine?.(b.baseY)?.translateToString?.(true) ?? '',
      lines: Array.from(
        { length: term?.rows ?? 0 },
        (_, i) => b?.getLine?.(b.baseY + i)?.translateToString?.(true) ?? ''
      ),
    };
  });

const warmDown = Number(args.warmDown ?? 0);
if (warmDown > 0) {
  await page.evaluate(
    async ({ events, x, y }) => {
      const el = document.elementFromPoint(x, y) as Element;
      for (let i = 0; i < events; i += 1) {
        el.dispatchEvent(
          new WheelEvent('wheel', {
            deltaX: 0,
            deltaY: 48,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
          })
        );
        await new Promise((r) => setTimeout(r, 4));
      }
    },
    { events: warmDown, x: box.x + box.width / 2, y: box.y + box.height / 2 }
  );
  await page.waitForTimeout(3000);
}
for (let round = 0; round < rounds; round += 1) {
  const before = await readState();
  await page.evaluate(() => {
    const s = (window as any).__benchStats;
    Object.assign(s, {
      sent: 0,
      sentBytes: 0,
      recv: 0,
      recvBytes: 0,
      firstRecvAt: 0,
      lastRecvAt: 0,
      sentAt: [],
      recvAt: [],
      longTasks: [],
      frames: [],
      active: true,
    });
    (window as any).__benchStart = performance.now();
  });
  const cdp = await context.newCDPSession(page);
  const t0 = Date.now();
  const sign = dir === 'up' ? -1 : 1;
  if (args.synthetic) {
    await page.evaluate(
      async ({ events, gapMs, deltaY, x, y, flick }) => {
        const el = document.elementFromPoint(x, y) as Element;
        for (let i = 0; i < events; i += 1) {
          // flick: momentum curve, starts at 6x delta and decays exponentially to ~0.2x
          const d = flick ? deltaY * (6 * Math.exp((-4 * i) / events) + 0.2) : deltaY;
          el.dispatchEvent(
            new WheelEvent('wheel', {
              deltaX: 0,
              deltaY: d,
              deltaMode: 0,
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
            })
          );
          await new Promise((r) => setTimeout(r, gapMs));
        }
      },
      {
        events,
        gapMs,
        deltaY: sign * delta,
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        flick: Boolean(args.flick),
      }
    );
  } else {
    for (let i = 0; i < events; i += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        deltaX: 0,
        deltaY: sign * delta,
      });
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  const dispatchMs = Date.now() - t0;
  // wait until incoming traffic settles for 700ms (max 15s)
  const settleStart = Date.now();
  let settled = false;
  while (Date.now() - settleStart < 15_000) {
    await page.waitForTimeout(100);
    const quiet = await page.evaluate(() => {
      const s = (window as any).__benchStats;
      const last = s.lastRecvAt || (window as any).__benchStart;
      return performance.now() - last > 700;
    });
    if (quiet) {
      settled = true;
      break;
    }
  }
  const result = await page.evaluate(() => {
    const s = (window as any).__benchStats;
    s.active = false;
    const start = (window as any).__benchStart as number;
    const frames: number[] = s.frames;
    const gaps: number[] = [];
    for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i] - frames[i - 1]);
    gaps.sort((a, b) => a - b);
    const p = (q: number) =>
      gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))] : 0;
    const lt: number[] = s.longTasks;
    return {
      sent: s.sent,
      sentBytes: s.sentBytes,
      recv: s.recv,
      recvBytes: s.recvBytes,
      firstRecvMs: s.firstRecvAt ? Math.round(s.firstRecvAt - start) : -1,
      settleMs: s.lastRecvAt ? Math.round(s.lastRecvAt - start) : -1,
      frames: frames.length,
      frameGapP50: Math.round(p(0.5) * 10) / 10,
      frameGapP95: Math.round(p(0.95) * 10) / 10,
      frameGapMax: Math.round((gaps[gaps.length - 1] ?? 0) * 10) / 10,
      framesOver33ms: gaps.filter((g) => g > 33).length,
      longTasks: lt.length,
      longTaskTotalMs: Math.round(lt.reduce((a, b) => a + b, 0)),
      longTaskMax: Math.round(lt.reduce((a, b) => Math.max(a, b), 0)),
    };
  });
  const after = await readState();
  await cdp.detach();
  const bestShift = (() => {
    let best: [number, number] = [0, -1];
    for (let sh = -60; sh <= 60; sh += 1) {
      let m = 0;
      after.lines.forEach((l: string, i: number) => {
        const j = i + sh;
        if (j >= 0 && j < before.lines.length && l.trim().length > 8 && l === before.lines[j])
          m += l.trim().length;
      });
      if (m > best[1]) best = [sh, m];
    }
    return best[0];
  })();
  (before as any).lines = undefined;
  (after as any).lines = undefined;
  console.log(
    JSON.stringify({
      label,
      round,
      dir,
      events,
      delta,
      gapMs,
      dispatchMs,
      settled,
      before,
      after,
      bestShift,
      ...result,
    })
  );
  await page.waitForTimeout(500);
}

await browser.close();
