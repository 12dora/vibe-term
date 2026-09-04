import { afterEach, describe, expect, test } from 'bun:test';
import { type StateSnapshotPayload, rolesFromName } from '@tmex/shared';
import {
  AgentConfirmationAlreadyDecidedError,
  AgentConfirmationNotFoundError,
} from '../agent/supervisor';
import {
  type MeshPresenceSource,
  type MessagingDeviceRuntime,
  createMessagingRuntimeHooks,
  mapSnapshotToWindows,
  setMessagingMeshRuntime,
  stripTrailingBlankLines,
} from './runtime-hooks';

afterEach(() => {
  setMessagingMeshRuntime(null);
});

const snapshot: StateSnapshotPayload = {
  deviceId: 'dev-1',
  session: {
    id: '$1',
    name: 'tmex',
    windows: [
      {
        id: '@1',
        name: 'main',
        customName: 'Main',
        index: 1,
        active: true,
        panes: [
          {
            id: '%1',
            windowId: '@1',
            index: 0,
            title: 'zsh',
            customName: 'shell',
            active: true,
            width: 80,
            height: 24,
          },
          {
            id: '%2',
            windowId: '@1',
            index: 1,
            title: 'vim',
            active: false,
            width: 80,
            height: 24,
          },
        ],
      },
    ],
  },
};

function fakeRuntime(overrides: Partial<MessagingDeviceRuntime> = {}): MessagingDeviceRuntime & {
  captured: Array<{ paneId: string; lines?: number }>;
  sent: Array<{ paneId: string; data: Uint8Array }>;
} {
  const captured: Array<{ paneId: string; lines?: number }> = [];
  const sent: Array<{ paneId: string; data: Uint8Array }> = [];
  return {
    captured,
    sent,
    isConnected: () => true,
    async capturePaneText(paneId, opts) {
      captured.push({ paneId, lines: opts?.historyLines });
      return 'line1\nline2\n\n';
    },
    sendInputBytes(paneId, data) {
      sent.push({ paneId, data: Uint8Array.from(data) });
    },
    ...overrides,
  };
}

function fakeMesh(overrides: Partial<MeshPresenceSource> = {}): MeshPresenceSource {
  return {
    nodeId: 'aa'.repeat(16),
    hub: null,
    uplink: { state: 'online' },
    attachedHub: () => ({ hubNodeId: 'hub-1' }),
    lastNodeList: {
      nodes: [
        {
          id: 'aa'.repeat(16),
          name: 'Home',
          online: true,
          version: '1.1.24',
        },
        {
          id: 'bb'.repeat(16),
          name: 'Office',
          online: true,
          version: '1.1.23',
        },
      ],
    },
    peers: {
      listReach: () => new Map([['bb'.repeat(16), 'lan']]),
    },
    userStore: {
      listCerts: () => [
        { nodeId: 'aa'.repeat(16), revokedLogSeq: null },
        { nodeId: 'bb'.repeat(16), revokedLogSeq: null },
      ],
      listNodes: () => [
        { id: 'aa'.repeat(16), name: 'Home', version: '1.1.24' },
        { id: 'bb'.repeat(16), name: 'Office', version: '1.1.23' },
      ],
    },
    ...overrides,
  };
}

describe('stripTrailingBlankLines', () => {
  test('removes trailing empty lines and keeps last content line', () => {
    expect(stripTrailingBlankLines('hello\nworld\n\n')).toBe('hello\nworld');
    expect(stripTrailingBlankLines('hello\nworld\n  \n')).toBe('hello\nworld');
    expect(stripTrailingBlankLines('hello')).toBe('hello');
    expect(stripTrailingBlankLines('\n\n')).toBe('');
  });
});

describe('mapSnapshotToWindows', () => {
  test('returns null without a live session', () => {
    expect(mapSnapshotToWindows(null)).toBeNull();
    expect(mapSnapshotToWindows({ deviceId: 'dev-1', session: null })).toBeNull();
  });

  test('projects ids, indexes, names and active flags', () => {
    const windows = mapSnapshotToWindows(snapshot);
    expect(windows).toEqual([
      {
        id: '@1',
        name: 'Main',
        index: 1,
        active: true,
        panes: [
          {
            id: '%1',
            index: 0,
            windowId: '@1',
            windowIndex: 1,
            windowName: 'Main',
            title: 'shell',
            active: true,
          },
          {
            id: '%2',
            index: 1,
            windowId: '@1',
            windowIndex: 1,
            windowName: 'Main',
            title: 'vim',
            active: false,
          },
        ],
      },
    ]);
  });
});

describe('createMessagingRuntimeHooks', () => {
  test('getDeviceTree reads the live snapshot and reports disconnected as null', () => {
    const snapshots = new Map<string, StateSnapshotPayload | null>([
      ['dev-1', snapshot],
      ['dev-2', null],
    ]);
    const hooks = createMessagingRuntimeHooks({
      getSnapshot: (deviceId) => snapshots.get(deviceId) ?? null,
    });
    expect(hooks.getDeviceTree?.('dev-1')?.[0]?.name).toBe('Main');
    expect(hooks.getDeviceTree?.('dev-2')).toBeNull();
    expect(hooks.getDeviceTree?.('missing')).toBeNull();
  });

  test('capturePane uses the per-device client, history lines, and trims trailing blanks', async () => {
    const runtime = fakeRuntime();
    const hooks = createMessagingRuntimeHooks({
      getSnapshot: (deviceId) => (deviceId === 'dev-1' ? snapshot : null),
      acquireRuntime: async () => runtime,
      releaseRuntime: async () => {},
    });
    await expect(hooks.capturePane?.('dev-1', '%1', 30)).resolves.toBe('line1\nline2');
    expect(runtime.captured).toEqual([{ paneId: '%1', lines: 30 }]);
    await expect(hooks.capturePane?.('missing', '%1', 10)).rejects.toThrow('capture-unavailable');
  });

  test('sendKeys sends the text bytes literally through sendInputBytes', async () => {
    const runtime = fakeRuntime();
    const hooks = createMessagingRuntimeHooks({
      getSnapshot: (deviceId) => (deviceId === 'dev-1' ? snapshot : null),
      acquireRuntime: async () => runtime,
      releaseRuntime: async () => {},
    });
    await hooks.sendKeys?.('dev-1', '%1', 'echo hi\r');
    expect(runtime.sent).toHaveLength(1);
    expect(runtime.sent[0]?.paneId).toBe('%1');
    expect(new TextDecoder().decode(runtime.sent[0]?.data)).toBe('echo hi\r');
    await hooks.sendKeys?.('dev-1', '%1', 'Enter');
    expect(new TextDecoder().decode(runtime.sent[1]?.data)).toBe('Enter');
    await expect(hooks.sendKeys?.('missing', '%1', 'x\r')).rejects.toThrow('send-unavailable');
  });

  test('capturePane and sendKeys fail when the device runtime is disconnected', async () => {
    const runtime = fakeRuntime({ isConnected: () => false });
    const hooks = createMessagingRuntimeHooks({
      getSnapshot: () => snapshot,
      acquireRuntime: async () => runtime,
      releaseRuntime: async () => {},
    });
    await expect(hooks.capturePane?.('dev-1', '%1', 10)).rejects.toThrow('device-disconnected');
    await expect(hooks.sendKeys?.('dev-1', '%1', 'x\r')).rejects.toThrow('device-disconnected');
  });

  test('decideConfirmation routes to supervisor and maps notFound / alreadyDecided', () => {
    const calls: Array<[string, boolean, string | undefined]> = [];
    const hooks = createMessagingRuntimeHooks({
      resolveConfirmation: (id, approved, reason) => {
        calls.push([id, approved, reason]);
        if (id === 'missing') throw new AgentConfirmationNotFoundError();
        if (id === 'done') throw new AgentConfirmationAlreadyDecidedError();
        if (id === 'boom') throw new Error('unavailable');
      },
    });
    expect(hooks.decideConfirmation?.('c1', true)).toEqual({ ok: true });
    expect(hooks.decideConfirmation?.('c2', false, 'nope')).toEqual({ ok: true });
    expect(hooks.decideConfirmation?.('missing', true)).toEqual({ ok: false, code: 'notFound' });
    expect(hooks.decideConfirmation?.('done', false)).toEqual({
      ok: false,
      code: 'alreadyDecided',
    });
    expect(hooks.decideConfirmation?.('boom', true)).toEqual({ ok: false, code: 'unavailable' });
    expect(calls).toEqual([
      ['c1', true, undefined],
      ['c2', false, 'nope'],
      ['missing', true, undefined],
      ['done', false, undefined],
      ['boom', true, undefined],
    ]);
  });

  test('getUplinkStatus is none for standalone and follows hub/relay attached state', () => {
    const standalone = createMessagingRuntimeHooks({
      isStandalone: () => true,
      roles: () => rolesFromName('standalone'),
      loadIdentity: () => ({ nodeId: null, name: 'Home', uplinkKind: null }),
      getMesh: () => null,
    });
    expect(standalone.getUplinkStatus?.()).toEqual({ kind: 'none', attached: false });

    const hubOnline = createMessagingRuntimeHooks({
      isStandalone: () => false,
      roles: () => rolesFromName('hub,node'),
      loadIdentity: () => ({ nodeId: 'n1', name: 'Home', uplinkKind: 'hub' }),
      getMesh: () => fakeMesh({ hub: { serving: true }, uplink: { state: 'online' } }),
    });
    expect(hubOnline.getUplinkStatus?.()).toEqual({ kind: 'hub', attached: true });

    const hubDetached = createMessagingRuntimeHooks({
      isStandalone: () => false,
      roles: () => rolesFromName('node'),
      loadIdentity: () => ({ nodeId: 'n1', name: 'Home', uplinkKind: 'hub' }),
      getMesh: () =>
        fakeMesh({
          hub: null,
          uplink: { state: 'offline' },
          attachedHub: () => null,
          lastNodeList: null,
        }),
    });
    expect(hubDetached.getUplinkStatus?.()).toEqual({ kind: 'hub', attached: false });

    const relayAttached = createMessagingRuntimeHooks({
      isStandalone: () => false,
      roles: () => rolesFromName('relay,node'),
      loadIdentity: () => ({ nodeId: 'n1', name: 'Home', uplinkKind: 'relay' }),
      getMesh: () =>
        fakeMesh({
          uplink: { state: 'offline' },
          attachedHub: () => ({ hubNodeId: 'relay-1' }),
        }),
    });
    expect(relayAttached.getUplinkStatus?.()).toEqual({ kind: 'relay', attached: true });

    const relayDetached = createMessagingRuntimeHooks({
      isStandalone: () => false,
      roles: () => rolesFromName('relay,node'),
      loadIdentity: () => ({ nodeId: 'n1', name: 'Home', uplinkKind: 'relay' }),
      getMesh: () =>
        fakeMesh({
          uplink: { state: 'connecting' },
          attachedHub: () => null,
        }),
    });
    expect(relayDetached.getUplinkStatus?.()).toEqual({ kind: 'relay', attached: false });

    const unknown = createMessagingRuntimeHooks({
      isStandalone: () => false,
      roles: () => rolesFromName('node'),
      loadIdentity: () => ({ nodeId: 'n1', name: 'Home', uplinkKind: null }),
      getMesh: () => null,
    });
    expect(unknown.getUplinkStatus?.()).toEqual({ kind: 'unknown', attached: 'unknown' });
  });

  test('listMeshNodes uses hub presence and peer reach as /api/mesh/nodes online flags', () => {
    const mesh = fakeMesh({
      lastNodeList: {
        nodes: [
          { id: 'aa'.repeat(16), name: 'Home', online: true, version: '1.1.24' },
          { id: 'bb'.repeat(16), name: 'Office', online: false, version: '1.1.23' },
          { id: 'cc'.repeat(16), name: 'Lab', online: false, version: null },
        ],
      },
      peers: {
        listReach: () =>
          new Map([
            ['bb'.repeat(16), null],
            ['cc'.repeat(16), 'wan'],
          ]),
      },
      userStore: {
        listCerts: () => [
          { nodeId: 'aa'.repeat(16), revokedLogSeq: null },
          { nodeId: 'bb'.repeat(16), revokedLogSeq: null },
          { nodeId: 'cc'.repeat(16), revokedLogSeq: null },
        ],
        listNodes: () => [
          { id: 'aa'.repeat(16), name: 'Home', version: '1.1.24' },
          { id: 'bb'.repeat(16), name: 'Office', version: '1.1.23' },
          { id: 'cc'.repeat(16), name: 'Lab', version: null },
        ],
      },
    });
    const hooks = createMessagingRuntimeHooks({
      getMesh: () => mesh,
      getLocalName: () => 'Home',
      getVersion: () => '1.1.24',
    });
    expect(hooks.listMeshNodes?.()).toEqual([
      {
        id: 'aa'.repeat(16),
        name: 'Home',
        online: true,
        version: '1.1.24',
        current: true,
      },
      {
        id: 'bb'.repeat(16),
        name: 'Office',
        online: false,
        version: '1.1.23',
        current: false,
      },
      {
        id: 'cc'.repeat(16),
        name: 'Lab',
        online: true,
        version: null,
        current: false,
      },
    ]);
  });

  test('listMeshNodes is empty without a mesh runtime; accessor is used by default', () => {
    const empty = createMessagingRuntimeHooks({ getMesh: () => null });
    expect(empty.listMeshNodes?.()).toEqual([]);

    const mesh = fakeMesh();
    setMessagingMeshRuntime(() => mesh);
    const viaAccessor = createMessagingRuntimeHooks({
      getLocalName: () => 'Home',
      getVersion: () => '1.1.24',
    });
    const listed = viaAccessor.listMeshNodes?.() ?? [];
    expect(listed.some((node) => node.current && node.name === 'Home')).toBe(true);
    expect(listed.some((node) => node.id === 'bb'.repeat(16) && node.online)).toBe(true);
  });
});
