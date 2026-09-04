import { registerCommandHandler } from '../executor';
import type { CommandRegistry } from '../registry';
import { approveSpec, denySpec, handleApprove, handleDeny } from './approve';
import { devicesSpec, handleDevices } from './devices';
import { handleHelp, helpSpec } from './help';
import { handleNodes, nodesSpec } from './nodes';
import { handlePanes, panesSpec } from './panes';
import { handleRun, runSpec } from './run';
import { handleStatus, statusSpec } from './status';
import { handleTail, tailSpec } from './tail';
import { handleWindows, windowsSpec } from './windows';

const modules = [
  { spec: helpSpec, handle: handleHelp },
  { spec: statusSpec, handle: handleStatus },
  { spec: nodesSpec, handle: handleNodes },
  { spec: devicesSpec, handle: handleDevices },
  { spec: windowsSpec, handle: handleWindows },
  { spec: panesSpec, handle: handlePanes },
  { spec: tailSpec, handle: handleTail },
  { spec: runSpec, handle: handleRun },
  { spec: approveSpec, handle: handleApprove },
  { spec: denySpec, handle: handleDeny },
] as const;

export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const module of modules) {
    registry.register(module.spec);
    registerCommandHandler(module.spec.name, module.handle);
  }
}

export { modules as builtinCommandModules };
