export {
  createTelegramAdapter,
  createWeixinAdapter,
  escapeHtml,
  renderPlain,
  renderTelegramHtml,
  type MessagingAdapter,
} from './adapter';
export {
  authorizeMessagingActor,
  type AuthDecision,
} from './authorize';
export {
  createCommandContext,
  errorResult,
  getMessagingRuntimeHooks,
  loadLocalIdentity,
  registerMessagingRuntime,
  resetMessagingRuntime,
  type CommandContext,
  type MessagingRuntimeHooks,
  type RemoteCommandExecutor,
  type UplinkStatus,
} from './context';
export {
  dispatchCommand,
  dispatchInboundText,
  registerCommandHandler,
  type DispatchOutcome,
} from './executor';
export { registerBuiltinCommands } from './handlers';
export { getBuiltinRegistry, processInboundCommand, resetBuiltinCommands } from './inbound';
export { createCommandRegistry, type CommandRegistry } from './registry';
