import { describe, expect, test } from 'bun:test';

import type { AgentSessionDto, Device, StateSnapshotPayload } from '@tmex/shared';

import { deriveAgentTabView } from './agent-tab-view';
import type { AgentStoreHandle, AgentTabState } from './use-agent-tab-state';

const devices: Device[] = [{ id: 'd1', name: 'laptop' } as Device];

function snapshot(paneId: string): StateSnapshotPayload {
  return {
    session: {
      windows: [
        {
          id: '@1',
          name: 'shell',
          customName: null,
          panes: [{ id: paneId, title: 'vim', customName: null }],
        },
      ],
    },
  } as unknown as StateSnapshotPayload;
}

function session(overrides: Partial<AgentSessionDto> = {}): AgentSessionDto {
  return {
    id: 's1',
    title: 'session',
    nodeId: null,
    deviceId: 'd1',
    paneId: '%1',
    providerId: null,
    modelId: 'm1',
    systemPrompt: null,
    writeMode: 'confirm',
    useProviderWebSearch: false,
    providerHostedTools: [],
    allowControlChars: false,
    originPaneTitle: null,
    originProcessName: null,
    status: 'idle',
    lastError: null,
    maxStepsPerTurn: 10,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as AgentSessionDto;
}

function state(overrides: Partial<AgentTabState> = {}): AgentTabState {
  return {
    agentStore: {} as AgentStoreHandle,
    bindingSnapshot: snapshot('%1'),
    nodeId: null,
    nodeOffline: undefined,
    devices,
    devicesLoading: false,
    devicesError: false,
    routeDeviceId: 'd1',
    routePaneId: '%1',
    routePaneTitle: 'vim',
    activeSessionId: 's1',
    activeSession: session(),
    draft: null,
    messages: [],
    inProgress: undefined,
    pendingConfirmations: undefined,
    sending: false,
    materializingDraft: false,
    queued: undefined,
    defaultWriteMode: 'confirm',
    ...overrides,
  };
}

describe('deriveAgentTabView orphan classification', () => {
  test('does not classify as orphan while devices are loading', () => {
    const view = deriveAgentTabView(
      state({ devices: undefined, devicesLoading: true, devicesError: false })
    );
    expect(view.isOrphan).toBe(false);
    expect(view.inputDisabled).toBe(false);
  });

  test('does not classify as orphan when the devices query failed', () => {
    const view = deriveAgentTabView(
      state({ devices: undefined, devicesLoading: false, devicesError: true })
    );
    expect(view.isOrphan).toBe(false);
    expect(view.inputDisabled).toBe(false);
  });

  test('classifies as orphan once a successful list omits the device', () => {
    const view = deriveAgentTabView(state({ devices: [{ id: 'other', name: 'x' } as Device] }));
    expect(view.isOrphan).toBe(true);
    expect(view.inputDisabled).toBe(true);
  });

  test('classifies as orphan when the bound pane vanished', () => {
    const view = deriveAgentTabView(state({ bindingSnapshot: snapshot('%9') }));
    expect(view.isOrphan).toBe(true);
  });
});

describe('deriveAgentTabView rebind eligibility', () => {
  test('offers rebind for another pane on the same device', () => {
    const view = deriveAgentTabView(
      state({ routePaneId: '%2', bindingSnapshot: snapshot('%1'), routePaneTitle: null })
    );
    expect(view.showPaneMismatch).toBe(true);
    expect(view.canRebind).toBe(true);
  });

  test('hides rebind when the route points at another device', () => {
    const view = deriveAgentTabView(state({ routeDeviceId: 'd2', routePaneId: '%2' }));
    expect(view.showPaneMismatch).toBe(true);
    expect(view.canRebind).toBe(false);
  });

  // 绑定 chip 解析的是会话所在设备的快照，路由切到别的设备不应把会话判成孤立
  test('keeps the binding valid while the route points at another device', () => {
    const view = deriveAgentTabView(
      state({ routeDeviceId: 'd2', routePaneId: '%2', routePaneTitle: null })
    );
    expect(view.binding?.state).toBe('valid');
    expect(view.isOrphan).toBe(false);
  });
});

describe('deriveAgentTabView node offline', () => {
  test('shows the offline banner and disables input while the route node is offline', () => {
    const view = deriveAgentTabView(state({ nodeOffline: true }));
    expect(view.showNodeOffline).toBe(true);
    expect(view.inputDisabled).toBe(true);
  });

  test('re-enables input once the node is back online, session error notwithstanding', () => {
    const view = deriveAgentTabView(
      state({
        nodeOffline: false,
        activeSession: session({ status: 'error', lastError: 'NODE_OFFLINE' }),
      })
    );
    expect(view.showNodeOffline).toBe(false);
    expect(view.inputDisabled).toBe(false);
    // 节点已回来，错误条如实回显直到用户重发
    expect(view.errorText).toBe('NODE_OFFLINE');
  });

  test('replaces the raw NODE_OFFLINE error with the offline banner while offline', () => {
    const view = deriveAgentTabView(
      state({
        nodeOffline: true,
        activeSession: session({ status: 'error', lastError: 'NODE_OFFLINE' }),
      })
    );
    expect(view.showNodeOffline).toBe(true);
    expect(view.errorText).toBeNull();
  });

  test('falls back to the session error when the host has no mesh state', () => {
    const view = deriveAgentTabView(
      state({
        nodeOffline: undefined,
        activeSession: session({ status: 'error', lastError: 'NODE_OFFLINE' }),
      })
    );
    expect(view.showNodeOffline).toBe(true);
    expect(view.inputDisabled).toBe(true);
  });

  test('leaves unrelated errors alone', () => {
    const view = deriveAgentTabView(
      state({
        nodeOffline: false,
        activeSession: session({ status: 'error', lastError: 'boom' }),
      })
    );
    expect(view.showNodeOffline).toBe(false);
    expect(view.errorText).toBe('boom');
  });
});
