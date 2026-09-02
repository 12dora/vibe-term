import type { TunnelActionRequest, TunnelProcessState } from '@tmex/shared';

export function processUp(state: TunnelProcessState): boolean {
  return state === 'running' || state === 'degraded';
}

const ACCESS_CONTROL_ACTIONS = [
  'set_access_credentials',
  'clear_access_credentials',
  'configure_access',
  'remove_access',
  'sync_access',
  'set_access_enforce',
  'set_access_mode',
] as const;

export type AccessControlAction = Extract<
  TunnelActionRequest,
  { action: (typeof ACCESS_CONTROL_ACTIONS)[number] }
>;

export function isAccessControlAction(body: TunnelActionRequest): body is AccessControlAction {
  return (ACCESS_CONTROL_ACTIONS as readonly string[]).includes(body.action);
}
