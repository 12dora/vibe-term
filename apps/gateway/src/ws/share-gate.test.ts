import { afterEach, describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  type BorshDispatchGateHost,
  type BorshDispatchHost,
  createBorshKindHandlers,
  dispatchBorshKind,
} from './borsh-dispatcher';
import type { GatewaySession } from './gateway-session';
import {
  SHARE_FORBIDDEN_CODE,
  SHARE_FORBIDDEN_MESSAGE,
  shareKindPolicy,
  shareVisibleClients,
} from './share-gate';
import { type ShareWsService, setShareWsServiceResolver } from './share-hooks';
import type { ShareScope } from './share-scope';
import { createBorshTestWs } from './test-helpers';

const SCOPE: ShareScope = { shareId: 'sh1', deviceId: 'device-a', windowId: '@1' };
const SERVER_EPOCH = new Uint8Array(16).fill(0x11);
const PANE_EPOCH = new Uint8Array(16).fill(0x22);
const REQUEST_ID = new Uint8Array(16).fill(0x33);

interface Harness {
  errors: Array<{ code: number; message: string }>;
  calls: string[];
  host: BorshDispatchGateHost & BorshDispatchHost;
}

function createHarness(inScopePanes: string[] = ['%1']): Harness {
  const errors: Harness['errors'] = [];
  const calls: string[] = [];
  const host = {
    sendError(_session: GatewaySession, _refSeq: number | null, code: number, message: string) {
      errors.push({ code, message });
    },
    sharePaneOracle: () => (deviceId: string, paneId: string) =>
      deviceId === SCOPE.deviceId && inScopePanes.includes(paneId),
    async handleDeviceConnect(_session: GatewaySession, deviceId: string) {
      calls.push(`connect:${deviceId}`);
    },
    handleDeviceDisconnect(_session: GatewaySession, deviceId: string) {
      calls.push(`disconnect:${deviceId}`);
    },
    handleTermInput(deviceId: string, paneId: string, data: string) {
      calls.push(`input:${deviceId}:${paneId}:${data}`);
    },
    handleTermPaste(deviceId: string, paneId: string, data: string) {
      calls.push(`paste:${deviceId}:${paneId}:${data}`);
    },
    handleResizePaneById(deviceId: string, paneId: string, cols?: number, rows?: number) {
      calls.push(`resize:${deviceId}:${paneId}:${cols}x${rows}`);
    },
    handleTermViewport() {
      calls.push('viewport');
    },
    handleSiteThemeUpdate() {
      calls.push('theme');
    },
    handleCloseWindow(deviceId: string, windowId: string) {
      calls.push(`close-window:${deviceId}:${windowId}`);
    },
    handleSplitPane() {
      calls.push('split');
    },
    handleTmuxSelect() {
      calls.push('select');
    },
    handleFocusPane(_deviceId: string, windowId: string, paneId: string) {
      calls.push(`focus:${windowId}:${paneId}`);
    },
    handleSetWindowStyle() {
      calls.push('window-style');
    },
    getOrCreateCanonicalSession() {
      calls.push('canonical');
      return { handleCommand: async () => {} };
    },
  } as unknown as BorshDispatchGateHost & BorshDispatchHost;
  return { errors, calls, host };
}

function shareSession(): GatewaySession {
  const session = createBorshTestWs();
  session.shareScope = SCOPE;
  return session;
}

async function dispatch(
  harness: Harness,
  session: GatewaySession,
  kind: number,
  payload: Uint8Array
): Promise<void> {
  await dispatchBorshKind(
    createBorshKindHandlers(harness.host),
    harness.host,
    session,
    kind,
    1,
    payload
  );
}

function paneTarget(paneId: string, deviceId = SCOPE.deviceId) {
  return { deviceId, serverEpoch: SERVER_EPOCH, paneId };
}

function terminalInput(paneId: string, deviceId = SCOPE.deviceId): Uint8Array {
  return wsBorsh.encodeCanonicalCommandPayload({
    TerminalInput: {
      requestId: REQUEST_ID,
      pane: paneTarget(paneId, deviceId),
      paneEpoch: PANE_EPOCH,
      inputId: new Uint8Array(16).fill(0x44),
      data: new TextEncoder().encode('ls'),
    },
  });
}

afterEach(() => {
  setShareWsServiceResolver(null);
});

describe('share kind policy', () => {
  test('只放行会话/设备/终端输入相关的 kind', () => {
    expect(shareKindPolicy(wsBorsh.KIND_DEVICE_CONNECT)).toBe('device');
    expect(shareKindPolicy(wsBorsh.KIND_DEVICE_DISCONNECT)).toBe('device');
    expect(shareKindPolicy(wsBorsh.KIND_TERM_INPUT)).toBe('pane');
    expect(shareKindPolicy(wsBorsh.KIND_TERM_PASTE)).toBe('pane');
    expect(shareKindPolicy(wsBorsh.KIND_TMUX_RESIZE_PANE)).toBe('pane');
    expect(shareKindPolicy(wsBorsh.KIND_TERM_VIEWPORT)).toBe('pane');
    expect(shareKindPolicy(wsBorsh.KIND_TMUX_SELECT)).toBe('window');
    expect(shareKindPolicy(wsBorsh.KIND_TMUX_FOCUS_PANE)).toBe('window');
    expect(shareKindPolicy(wsBorsh.KIND_CANONICAL_COMMAND)).toBe('canonical');
    for (const kind of [
      wsBorsh.KIND_SITE_THEME_UPDATE,
      wsBorsh.KIND_TMUX_SET_WINDOW_STYLE,
      wsBorsh.KIND_AGENT_SUBSCRIBE,
      wsBorsh.KIND_TMUX_CLOSE_WINDOW,
      wsBorsh.KIND_TMUX_SPLIT_PANE,
      wsBorsh.KIND_TMUX_APPLY_STACKED_LAYOUT,
    ]) {
      expect(shareKindPolicy(kind)).toBe('deny');
    }
  });
});

describe('share inbound gate', () => {
  test('被禁 kind 回 SHARE_FORBIDDEN 且不产生副作用', async () => {
    const harness = createHarness();
    await dispatch(
      harness,
      shareSession(),
      wsBorsh.KIND_SITE_THEME_UPDATE,
      wsBorsh.encodePayload(wsBorsh.schema.SiteThemeUpdateC2SSchema, {
        theme: wsBorsh.SITE_THEME_DARK,
      })
    );
    await dispatch(
      harness,
      shareSession(),
      wsBorsh.KIND_TMUX_CLOSE_WINDOW,
      wsBorsh.encodePayload(wsBorsh.schema.TmuxCloseWindowSchema, {
        deviceId: SCOPE.deviceId,
        windowId: SCOPE.windowId,
      })
    );
    expect(harness.calls).toEqual([]);
    expect(harness.errors).toEqual([
      { code: SHARE_FORBIDDEN_CODE, message: SHARE_FORBIDDEN_MESSAGE },
      { code: SHARE_FORBIDDEN_CODE, message: SHARE_FORBIDDEN_MESSAGE },
    ]);
  });

  test('普通连接不受白名单影响', async () => {
    const harness = createHarness();
    await dispatch(
      harness,
      createBorshTestWs(),
      wsBorsh.KIND_TMUX_CLOSE_WINDOW,
      wsBorsh.encodePayload(wsBorsh.schema.TmuxCloseWindowSchema, {
        deviceId: 'device-b',
        windowId: '@9',
      })
    );
    expect(harness.calls).toEqual(['close-window:device-b:@9']);
    expect(harness.errors).toEqual([]);
  });

  test('DEVICE_CONNECT 只允许 scope 设备', async () => {
    const harness = createHarness();
    const payload = (deviceId: string) =>
      wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectSchema, { deviceId });
    await dispatch(harness, shareSession(), wsBorsh.KIND_DEVICE_CONNECT, payload('device-b'));
    expect(harness.calls).toEqual([]);
    expect(harness.errors).toHaveLength(1);
    await dispatch(harness, shareSession(), wsBorsh.KIND_DEVICE_CONNECT, payload(SCOPE.deviceId));
    expect(harness.calls).toEqual([`connect:${SCOPE.deviceId}`]);
    expect(harness.errors).toHaveLength(1);
  });

  test('TERM_INPUT 只允许 scope window 内的 pane', async () => {
    const harness = createHarness(['%1']);
    const payload = (paneId: string) =>
      wsBorsh.encodePayload(wsBorsh.schema.TermInputSchema, {
        deviceId: SCOPE.deviceId,
        paneId,
        encoding: 0,
        data: new TextEncoder().encode('ls'),
        isComposing: false,
      });
    await dispatch(harness, shareSession(), wsBorsh.KIND_TERM_INPUT, payload('%9'));
    expect(harness.calls).toEqual([]);
    expect(harness.errors).toHaveLength(1);
    await dispatch(harness, shareSession(), wsBorsh.KIND_TERM_INPUT, payload('%1'));
    expect(harness.calls).toEqual([`input:${SCOPE.deviceId}:%1:ls`]);
  });

  test('TMUX_SELECT 只允许 scope window', async () => {
    const harness = createHarness(['%1']);
    const payload = (windowId: string | null, paneId: string | null) =>
      wsBorsh.encodePayload(wsBorsh.schema.TmuxSelectSchema, {
        deviceId: SCOPE.deviceId,
        windowId,
        paneId,
        selectToken: new Uint8Array(16).fill(0x77),
        wantHistory: false,
        cols: 80,
        rows: 24,
      });

    await dispatch(harness, shareSession(), wsBorsh.KIND_TMUX_SELECT, payload('@9', '%9'));
    expect(harness.calls).toEqual([]);
    expect(harness.errors).toEqual([
      { code: SHARE_FORBIDDEN_CODE, message: SHARE_FORBIDDEN_MESSAGE },
    ]);

    await dispatch(
      harness,
      shareSession(),
      wsBorsh.KIND_TMUX_SELECT,
      payload(SCOPE.windowId, '%9')
    );
    expect(harness.calls).toEqual([]);
    expect(harness.errors).toHaveLength(2);

    await dispatch(
      harness,
      shareSession(),
      wsBorsh.KIND_TMUX_SELECT,
      payload(SCOPE.windowId, '%1')
    );
    expect(harness.calls).toEqual(['select']);
    expect(harness.errors).toHaveLength(2);

    await dispatch(harness, shareSession(), wsBorsh.KIND_TMUX_SELECT, payload(null, null));
    expect(harness.calls).toEqual(['select']);
    expect(harness.errors).toHaveLength(3);
  });

  test('FOCUS_PANE 只允许 scope window 内的 pane', async () => {
    const harness = createHarness(['%1']);
    const payload = (windowId: string, paneId: string) =>
      wsBorsh.encodePayload(wsBorsh.schema.TmuxFocusPaneSchema, {
        deviceId: SCOPE.deviceId,
        windowId,
        paneId,
      });

    await dispatch(harness, shareSession(), wsBorsh.KIND_TMUX_FOCUS_PANE, payload('@9', '%9'));
    expect(harness.calls).toEqual([]);
    expect(harness.errors).toHaveLength(1);

    await dispatch(
      harness,
      shareSession(),
      wsBorsh.KIND_TMUX_FOCUS_PANE,
      payload(SCOPE.windowId, '%9')
    );
    expect(harness.calls).toEqual([]);
    expect(harness.errors).toHaveLength(2);

    await dispatch(
      harness,
      shareSession(),
      wsBorsh.KIND_TMUX_FOCUS_PANE,
      payload(SCOPE.windowId, '%1')
    );
    expect(harness.calls).toEqual([`focus:${SCOPE.windowId}:%1`]);
  });

  test('SET_WINDOW_STYLE 仍被拒绝', async () => {
    const harness = createHarness(['%1']);
    await dispatch(
      harness,
      shareSession(),
      wsBorsh.KIND_TMUX_SET_WINDOW_STYLE,
      wsBorsh.encodePayload(wsBorsh.schema.TmuxSetWindowStyleSchema, {
        deviceId: SCOPE.deviceId,
        style: 'bg=default',
      })
    );
    expect(harness.calls).toEqual([]);
    expect(harness.errors).toEqual([
      { code: SHARE_FORBIDDEN_CODE, message: SHARE_FORBIDDEN_MESSAGE },
    ]);
  });

  test('CANONICAL_COMMAND 的 pane target 必须在 scope 内', async () => {
    const harness = createHarness(['%1']);
    await dispatch(harness, shareSession(), wsBorsh.KIND_CANONICAL_COMMAND, terminalInput('%9'));
    expect(harness.calls).toEqual([]);
    expect(harness.errors).toEqual([
      { code: SHARE_FORBIDDEN_CODE, message: SHARE_FORBIDDEN_MESSAGE },
    ]);
    await dispatch(harness, shareSession(), wsBorsh.KIND_CANONICAL_COMMAND, terminalInput('%1'));
    expect(harness.calls).toEqual(['canonical']);
  });

  test('CANONICAL_COMMAND 跨设备直接拒绝', async () => {
    const harness = createHarness(['%1']);
    await dispatch(
      harness,
      shareSession(),
      wsBorsh.KIND_CANONICAL_COMMAND,
      terminalInput('%1', 'device-b')
    );
    expect(harness.calls).toEqual([]);
    expect(harness.errors).toHaveLength(1);
  });

  test('订阅命令只按设备判定，pane 交给 canonical 会话回 NOT_FOUND', async () => {
    const harness = createHarness(['%1']);
    const payload = wsBorsh.encodeCanonicalCommandPayload({
      SetPaneSubscriptions: {
        generation: 1n,
        activePanes: [{ pane: paneTarget('%9'), cursor: null }],
        hotPanes: [],
      },
    });
    await dispatch(harness, shareSession(), wsBorsh.KIND_CANONICAL_COMMAND, payload);
    expect(harness.calls).toEqual(['canonical']);
    expect(harness.errors).toEqual([]);
  });
});

describe('share input recording', () => {
  function installRecorder(): {
    inputs: Array<[string, string]>;
    resizes: Array<[string, number, number]>;
  } {
    const inputs: Array<[string, string]> = [];
    const resizes: Array<[string, number, number]> = [];
    const service: ShareWsService = {
      recordInput: (scope, paneId, bytes) => {
        expect(scope.shareId).toBe(SCOPE.shareId);
        inputs.push([paneId, new TextDecoder().decode(bytes)]);
      },
      recordResize: (_scope, paneId, cols, rows) => resizes.push([paneId, cols, rows]),
      onEnded: () => () => {},
      setViewerCounter: () => {},
    };
    setShareWsServiceResolver(() => service);
    return { inputs, resizes };
  }

  test('legacy TERM_INPUT / RESIZE_PANE 记入分享日志', async () => {
    const recorder = installRecorder();
    const harness = createHarness(['%1']);
    await dispatch(
      harness,
      shareSession(),
      wsBorsh.KIND_TERM_INPUT,
      wsBorsh.encodePayload(wsBorsh.schema.TermInputSchema, {
        deviceId: SCOPE.deviceId,
        paneId: '%1',
        encoding: 0,
        data: new TextEncoder().encode('id\r'),
        isComposing: false,
      })
    );
    await dispatch(
      harness,
      shareSession(),
      wsBorsh.KIND_TMUX_RESIZE_PANE,
      wsBorsh.encodePayload(wsBorsh.schema.TmuxResizePaneSchema, {
        deviceId: SCOPE.deviceId,
        paneId: '%1',
        cols: 100,
        rows: 30,
      })
    );
    expect(recorder.inputs).toEqual([['%1', 'id\r']]);
    expect(recorder.resizes).toEqual([['%1', 100, 30]]);
  });

  test('canonical TerminalInput 记入分享日志，越权命令不记', async () => {
    const recorder = installRecorder();
    const harness = createHarness(['%1']);
    await dispatch(harness, shareSession(), wsBorsh.KIND_CANONICAL_COMMAND, terminalInput('%9'));
    expect(recorder.inputs).toEqual([]);
    await dispatch(harness, shareSession(), wsBorsh.KIND_CANONICAL_COMMAND, terminalInput('%1'));
    expect(recorder.inputs).toEqual([['%1', 'ls']]);
  });

  test('普通连接的输入不记入分享日志', async () => {
    const recorder = installRecorder();
    const harness = createHarness(['%1']);
    await dispatch(
      harness,
      createBorshTestWs(),
      wsBorsh.KIND_TERM_INPUT,
      wsBorsh.encodePayload(wsBorsh.schema.TermInputSchema, {
        deviceId: SCOPE.deviceId,
        paneId: '%1',
        encoding: 0,
        data: new TextEncoder().encode('x'),
        isComposing: false,
      })
    );
    expect(recorder.inputs).toEqual([]);
  });
});

describe('shareVisibleClients', () => {
  test('分享连接只收 scope 内 pane 的事件，普通连接不受影响', () => {
    const normal = createBorshTestWs();
    const shared = shareSession();
    const clients = [normal, shared] as unknown as GatewaySession[];
    const oracle = (_scope: ShareScope, deviceId: string, paneId: string) =>
      deviceId === SCOPE.deviceId && paneId === '%1';

    expect(Array.from(shareVisibleClients(clients, SCOPE.deviceId, '%1', oracle))).toEqual(clients);
    expect(Array.from(shareVisibleClients(clients, SCOPE.deviceId, '%9', oracle))).toEqual([
      normal as unknown as GatewaySession,
    ]);
    expect(Array.from(shareVisibleClients(clients, SCOPE.deviceId, null, oracle))).toEqual([
      normal as unknown as GatewaySession,
    ]);
  });

  test('没有分享连接时原样返回集合', () => {
    const clients = [createBorshTestWs()] as unknown as GatewaySession[];
    expect(shareVisibleClients(clients, SCOPE.deviceId, null, () => false)).toBe(clients);
  });
});
