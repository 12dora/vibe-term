import { describe, expect, test } from 'bun:test';

import type { AgentSessionDto, Device, StateSnapshotPayload } from '@tmex/shared';

import { deriveAgentTabView } from './agent-tab-view';
import type { AgentStoreHandle, AgentTabState } from './use-agent-tab-state';

const devices: Device[] = [{ id: 'd1', name: 'laptop' } as Device];

function snapshots(paneId: string): Record<string, StateSnapshotPayload | undefined> {
  return {
    d1: {
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
    } as unknown as StateSnapshotPayload,
  };
}

function session(overrides: Partial<AgentSessionDto> = {}): AgentSessionDto {
  return {
    id: 's1',
    title: 'session',
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
    snapshots: snapshots('%1'),
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
    const view = deriveAgentTabView(state({ snapshots: snapshots('%9') }));
    expect(view.isOrphan).toBe(true);
  });
});

describe('deriveAgentTabView rebind eligibility', () => {
  test('offers rebind for another pane on the same device', () => {
    const view = deriveAgentTabView(
      state({ routePaneId: '%2', snapshots: snapshots('%1'), routePaneTitle: null })
    );
    expect(view.showPaneMismatch).toBe(true);
    expect(view.canRebind).toBe(true);
  });

  test('hides rebind when the route points at another device', () => {
    const view = deriveAgentTabView(state({ routeDeviceId: 'd2', routePaneId: '%2' }));
    expect(view.showPaneMismatch).toBe(true);
    expect(view.canRebind).toBe(false);
  });
});
