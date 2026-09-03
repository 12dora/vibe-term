import { type LocalAuthContext, openInstallAuth } from '../lib/local-auth';
import type { ParsedArgs } from '../types';

export async function withAuth<T>(
  parsed: ParsedArgs,
  io: { auth?: LocalAuthContext } | undefined,
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
