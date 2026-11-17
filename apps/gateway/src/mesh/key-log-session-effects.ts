import type { KeyLogEffect } from '@vibeterm/shared/auth';

/** 会带来会话失效的 key log 效果；其余记录类型不必触发 socket 复核。 */
const SESSION_REVOKE_EFFECTS: ReadonlySet<KeyLogEffect['type']> = new Set([
  'revokeAllSessions',
  'revokeSessionsByCredential',
  'revokeSessionsVia',
]);

export function hasSessionRevokeEffect(effects: readonly KeyLogEffect[]): boolean {
  return effects.some((effect) => SESSION_REVOKE_EFFECTS.has(effect.type));
}
