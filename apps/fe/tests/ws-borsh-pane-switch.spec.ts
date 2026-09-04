import { expect, test } from '@playwright/test';
import { createTwoWindowSession, ensureCleanSession } from './helpers/tmux';
import {
  KIND,
  attachPaneFeedCollector,
  decodeEnvelope,
  decodeTmuxSelect,
  isGatewayWsUrl,
} from './helpers/ws-borsh';

// 桌面分屏时代，同窗切 pane 走轻量 FOCUS_PANE；完整 select 语义由跨 window 切换保留，
// 故用两个 window 场景。legacy 的 SWITCH_ACK → TERM_HISTORY → LIVE_RESUME 屏障已于
// 1.1.23 下线，切换后的画面重建改由 canonical 首屏事务 + 订阅代承担。
test('ws-borsh: TMUX_SELECT carries cols/rows and the canonical screen transaction completes', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-barrier-${Date.now()}`;
  const { paneIds, windowIds } = createTwoWindowSession(sessionName);
  expect(paneIds.length >= 2).toBeTruthy();

  const name = `e2e-borsh-barrier-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const selects: Array<{
    tokenHex: string;
    paneId: string | null;
    cols: number | null;
    rows: number | null;
  }> = [];
  const received = attachPaneFeedCollector(page);

  page.on('websocket', (ws) => {
    if (!isGatewayWsUrl(ws.url())) return;
    ws.on('framesent', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope || envelope.kind !== KIND.TMUX_SELECT) return;
      const select = decodeTmuxSelect(envelope.payload);
      selects.push({
        tokenHex: select.selectToken.toString('hex'),
        paneId: select.paneId,
        cols: select.cols,
        rows: select.rows,
      });
    });
  });

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();

    const targetPane = paneIds[1];
    const targetWindow = windowIds[1];

    await expect(page.getByTestId(`window-item-${targetWindow}`)).toBeVisible({ timeout: 20_000 });
    await page.getByTestId(`window-item-${targetWindow}`).click();

    await expect
      .poll(() => selects.filter((s) => s.paneId === targetPane).length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    // tmux 控制面：select 仍带本地视口尺寸，网关据此仲裁 window 几何
    const capturedSelect = selects.find((s) => s.paneId === targetPane);
    expect(capturedSelect).toBeTruthy();
    expect(capturedSelect?.cols).not.toBeNull();
    expect(capturedSelect?.rows).not.toBeNull();
    expect((capturedSelect?.cols ?? 0) > 1).toBeTruthy();
    expect((capturedSelect?.rows ?? 0) > 1).toBeTruthy();

    // canonical 数据面：目标 pane 的首屏事务成对完成（Begin 早于 Commit、requestId 一致）
    await expect.poll(() => received.screenCommitted(targetPane), { timeout: 20_000 }).toBeTruthy();
    const phases = received.screenPhasesByPane.get(targetPane) ?? [];
    const beginIndex = phases.findIndex((entry) => entry.phase === 'begin');
    const commitIndex = phases.findIndex((entry) => entry.phase === 'commit');
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(beginIndex);
    expect(phases[commitIndex]?.requestId).toBe(phases[beginIndex]?.requestId);
    // 目标 pane 进入订阅集合，画面才会持续推送
    expect(received.subscriptions.at(-1)?.activePaneIds ?? []).toContain(targetPane);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('ws-borsh: rapid window switches keep subscription generations monotonic and land on the final pane', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-rapid-${Date.now()}`;
  const { paneIds, windowIds } = createTwoWindowSession(sessionName);
  expect(paneIds.length >= 2).toBeTruthy();

  const name = `e2e-borsh-rapid-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const received = attachPaneFeedCollector(page);

  const firstPane = paneIds[0];
  const firstWindow = windowIds[0];
  const secondWindow = windowIds[1];

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();

    await expect(page.getByTestId(`window-item-${firstWindow}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`window-item-${secondWindow}`)).toBeVisible({ timeout: 20_000 });

    await expect.poll(() => received.subscriptions.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const baseline = received.subscriptions.length;

    // 连点两次跨 window 切换：中间那次订阅还没落地就被下一次覆盖
    await page.getByTestId(`window-item-${secondWindow}`).click();
    await page.getByTestId(`window-item-${firstWindow}`).click();

    await expect
      .poll(() => received.subscriptions.length, { timeout: 20_000 })
      .toBeGreaterThan(baseline);
    await expect
      .poll(() => received.subscriptions.at(-1)?.activePaneIds ?? [], { timeout: 20_000 })
      .toContain(firstPane);

    // 只看订阅集合会漏判：第一个 pane 在 60s 保活期内本来就一直在订阅里，
    // 第二次点击没生效也照样命中。必须同时断言选中态真的落回第一个窗口。
    await page.waitForURL((url) => url.pathname.includes(encodeURIComponent(firstPane ?? '')), {
      timeout: 20_000,
    });
    await expect(page.getByTestId(`window-item-${firstWindow}`)).toHaveAttribute(
      'data-active',
      'true'
    );
    await expect(page.getByTestId(`window-item-${secondWindow}`)).not.toHaveAttribute(
      'data-active',
      'true'
    );

    await page.waitForTimeout(1000);

    // 订阅代单调递增：被取消的那次不会以更旧的 generation 后到并覆盖最终订阅集合
    const generations = received.subscriptions.map((entry) => entry.generation);
    for (let index = 1; index < generations.length; index += 1) {
      expect(generations[index] >= generations[index - 1]).toBeTruthy();
    }
    expect(received.subscriptions.at(-1)?.activePaneIds ?? []).toContain(firstPane);

    // 没有任何 PaneData 落在从未进过订阅集合的 pane 上
    const everSubscribed = new Set(received.subscriptions.flatMap((entry) => entry.activePaneIds));
    for (const paneId of received.canonicalOutputTextByPane.keys()) {
      expect(everSubscribed.has(paneId)).toBeTruthy();
    }
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
