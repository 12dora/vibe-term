import { rolesFromName } from '@tmex/shared';
import type { CommandContext, DeviceView, MeshNodeView, TmuxWindowView } from './context';
import { registerBuiltinCommands } from './handlers';
import { createCommandRegistry } from './registry';

export function createTestTranslate() {
  return (key: string, params?: Record<string, unknown>) => {
    if (!params) return key;
    return `${key}:${JSON.stringify(params)}`;
  };
}

export function createTestContext(
  overrides: Partial<CommandContext> & {
    devices?: DeviceView[];
    nodes?: MeshNodeView[];
    windowsByDevice?: Record<string, TmuxWindowView[] | null>;
  } = {}
): CommandContext {
  const registry = createCommandRegistry();
  registerBuiltinCommands(registry);
  const devices = overrides.devices ?? [];
  const nodes = overrides.nodes ?? [];
  const windowsByDevice = overrides.windowsByDevice ?? {};
  const { devices: _d, nodes: _n, windowsByDevice: _w, ...rest } = overrides;
  void _d;
  void _n;
  void _w;
  return {
    t: createTestTranslate(),
    registry,
    localNodeId: 'local-id',
    localName: 'Home',
    version: '1.1.24',
    roles: rolesFromName('node'),
    uplink: { kind: 'hub', attached: true },
    meshMode: 'mesh',
    listNodes: () => nodes,
    listDevices: () => devices,
    getWindows: (deviceId) =>
      Object.prototype.hasOwnProperty.call(windowsByDevice, deviceId)
        ? (windowsByDevice[deviceId] ?? null)
        : [],
    capturePane: async () => 'captured',
    sendKeys: async () => {},
    decideConfirmation: () => ({ ok: true }),
    ...rest,
  };
}
