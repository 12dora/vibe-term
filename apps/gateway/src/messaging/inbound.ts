import type { CommandActor, CommandResult } from '@tmex/shared/messaging';
import type { MessagingAdapter } from './adapter';
import { createCommandContext } from './context';
import { dispatchInboundText } from './executor';
import { registerBuiltinCommands } from './handlers';
import { createCommandRegistry } from './registry';

let builtinReady = false;
const builtinRegistry = createCommandRegistry();

function ensureBuiltin(): void {
  if (builtinReady) return;
  registerBuiltinCommands(builtinRegistry);
  builtinReady = true;
}

export function getBuiltinRegistry() {
  ensureBuiltin();
  return builtinRegistry;
}

export async function processInboundCommand(params: {
  rawText: string;
  actor: CommandActor;
  adapter: MessagingAdapter;
}): Promise<{ silent: true } | { silent: false; chunks: string[]; result: CommandResult }> {
  ensureBuiltin();
  const ctx = createCommandContext(builtinRegistry);
  const outcome = await dispatchInboundText(params.rawText, { actor: params.actor }, ctx);
  if (outcome.silent) return { silent: true };
  return {
    silent: false,
    result: outcome.result,
    chunks: params.adapter.render(outcome.result),
  };
}

export function resetBuiltinCommands(): void {
  builtinReady = false;
}
