import {
  ensureNodeIdentity,
  selfSignedNodeCertificate,
} from '../../../../apps/gateway/src/auth/node-identity-service';
import { encodeAdmitNodePayload } from '../../../shared/src/auth';
import { type LocalAuthContext, openInstallAuth } from '../lib/local-auth';
import { resolvePassword } from '../lib/password';
import { isStandaloneRoles, parseTmexRoles } from '../lib/roles';
import { fingerprintPublicKey } from '../lib/totp-uri';
import type { ParsedArgs } from '../types';
import type { HubIo } from './hub';

function log(io: HubIo | undefined, message: string): void {
  (io?.log ?? console.log)(message);
}

async function withAuth<T>(
  parsed: ParsedArgs,
  io: HubIo | undefined,
  fn: (ctx: LocalAuthContext) => Promise<T>
): Promise<T> {
  if (io?.auth) {
    return await fn(io.auth);
  }
  const ctx = await openInstallAuth(parsed);
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

export async function runMeshResetRoot(
  parsed: ParsedArgs,
  io: HubIo = {}
): Promise<{ userId: string; rootEpoch: number; fingerprint: string }> {
  const roles = parseTmexRoles(io.auth?.env.TMEX_ROLES ?? process.env.TMEX_ROLES);
  if (isStandaloneRoles(roles)) {
    throw new Error('mesh reset-root is refused when TMEX_ROLES is standalone');
  }

  const password = await resolvePassword({
    password: io.password,
    confirm: io.password === undefined,
    prompt: 'New password',
    confirmPrompt: 'Confirm new password',
  });

  return await withAuth(parsed, io, async (ctx) => {
    const existing = ctx.db
      .select()
      .from((await import('../../../../apps/gateway/src/db/schema')).users)
      .all();
    const first = existing[0];
    if (!first) {
      throw new Error('no local user to reset; run hub user add first');
    }
    const username = first.username;
    const boot = await ctx.userKeys.bootstrapUser({ username, password });
    const identity = await ensureNodeIdentity(ctx.identityStore);
    const admit = await selfSignedNodeCertificate(identity, boot.rootKey, {
      uid: boot.userId,
      rootEpoch: boot.rootEpoch,
      now: io.now?.() ?? Date.now(),
    });
    const applied = await ctx.userKeys.signAndApply(boot.userId, boot.rootKey, {
      type: 'admit-node',
      payload: encodeAdmitNodePayload(admit),
    });
    if (!applied.ok) {
      throw new Error(`admit-node failed: ${applied.error}`);
    }
    const fingerprint = fingerprintPublicKey(boot.rootPublicKey);
    log(io, `root reset for ${username}; re-enroll other machines`);
    log(io, `root public key fingerprint: ${fingerprint}`);
    return { userId: boot.userId, rootEpoch: boot.rootEpoch, fingerprint };
  });
}
