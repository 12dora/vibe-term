import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { installWindowStorage } from './test-utils';

installWindowStorage();

const sentMessages: Array<{ kind: number; payload: Uint8Array }> = [];
const sendMock = mock((kind: number, payload: Uint8Array) => {
  sentMessages.push({ kind, payload });
  return true;
});
const isReadyMock = mock(() => true);

// 只替换建连入口：命令编码走 ws-client 真实实现（Borsh），断言直接读 payload 里的字段。
const wsActual = await import('@tmex/ws-client');
mock.module('@tmex/ws-client', () => ({
  ...wsActual,
  getBorshClient: () => ({
    send: sendMock,
    isReady: isReadyMock,
    onStateChange: () => () => {},
    onMessage: () => () => {},
    onError: () => () => {},
    onLatency: () => () => {},
    onChunkProgress: () => () => {},
    connect: () => {},
    disconnect: () => {},
    getState: () => 'READY',
    hasConnectedOnce: true,
    latencyMs: null,
    serverCapabilities: [],
  }),
  getSelectStateMachine: () => ({
    dispatch: () => {},
    cleanup: () => {},
    getTransaction: () => null,
    setCallbacks: () => {},
  }),
}));

const { useTmuxStore, useUIStore } = await import('./index');

const KIND_TMUX_SET_WINDOW_STYLE = wsBorsh.KIND_TMUX_SET_WINDOW_STYLE;

function decodeWindowStyle(payload: Uint8Array) {
  return wsBorsh.decodePayload(wsBorsh.schema.TmuxSetWindowStyleSchema, payload);
}

describe('useTmuxStore syncThemeAfterResize', () => {
  beforeEach(() => {
    sentMessages.length = 0;
    sendMock.mockClear();
    isReadyMock.mockImplementation(() => true);
    useUIStore.setState({ theme: 'dark' });
  });

  test('syncThemeAfterResize sends KIND_TMUX_SET_WINDOW_STYLE for current theme', () => {
    useUIStore.setState({ theme: 'dark' });
    useTmuxStore.getState().syncThemeAfterResize('device-a');

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].kind).toBe(KIND_TMUX_SET_WINDOW_STYLE);
  });

  test('syncThemeAfterResize uses light style when UI theme is light', () => {
    useUIStore.setState({ theme: 'light' });
    useTmuxStore.getState().syncThemeAfterResize('device-a');

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].kind).toBe(KIND_TMUX_SET_WINDOW_STYLE);
    const { deviceId, style } = decodeWindowStyle(sentMessages[0].payload);
    expect(deviceId).toBe('device-a');
    expect(style).toContain('bg=#e1e1e1');
  });

  test('syncThemeAfterResize uses dark style when UI theme is dark', () => {
    useUIStore.setState({ theme: 'dark' });
    useTmuxStore.getState().syncThemeAfterResize('device-a');

    expect(decodeWindowStyle(sentMessages[0].payload).style).toContain('bg=#262626');
  });

  test('syncThemeAfterResize skips when deviceId is empty', () => {
    useTmuxStore.getState().syncThemeAfterResize('');

    expect(sentMessages.length).toBe(0);
  });

  test('syncThemeAfterResize skips when ws not ready', () => {
    isReadyMock.mockImplementation(() => false);
    useTmuxStore.getState().syncThemeAfterResize('device-a');

    expect(sentMessages.length).toBe(0);
  });
});
