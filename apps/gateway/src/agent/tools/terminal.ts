import type { Tool } from 'ai';
import { createGetPaneInfoTool } from './pane-info';
import { createReadScreenTool } from './read-screen';
import { createRunCommandTool } from './run-command-tool';
import { createSendInputTool } from './send-input';
import { type CreateTerminalToolsOptions, createTerminalToolContext } from './terminal-context';

export type {
  CreateTerminalToolsOptions,
  TerminalRuntimeLike,
  TerminalToolContext,
  TerminalToolError,
} from './terminal-context';
export {
  checkRuntimeAlive,
  createTerminalToolContext,
  failTool,
  liveEmulator,
} from './terminal-context';
export {
  COMBO_KEY_ENUM,
  KEY_SEQUENCES,
  SEND_INPUT_KEYS,
  SEND_INPUT_MODIFIERS,
  encodeCombo,
  encodeKeysToSequence,
} from './terminal-encoding';
export type { ComboKey, SendInputKey, SendInputModifier } from './terminal-encoding';

export function createTerminalTools(options: CreateTerminalToolsOptions): Record<string, Tool> {
  const ctx = createTerminalToolContext(options);
  return {
    read_screen: createReadScreenTool(ctx),
    send_input: createSendInputTool(ctx),
    get_pane_info: createGetPaneInfoTool(ctx),
    run_command: createRunCommandTool(ctx),
  };
}
