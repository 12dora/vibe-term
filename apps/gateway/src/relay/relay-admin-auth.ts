import type { RelayConfigStore } from './relay-config-store';
import { constantTimeEqual, generateRelayAdminToken, sha256Hex } from './relay-password';

export type RelayLocalAuthCheck = (req: Request) => boolean | Promise<boolean>;

export type RelayAdminAuthOptions = {
  /** `TMEX_RELAY_ADMIN_TOKEN`；缺失时首启生成一枚并把 sha256 写进 relay_config。 */
  configuredToken?: string | null;
  store: RelayConfigStore;
  now: () => number;
  /** `relay,node` 时由 assemble 注入：本机 node-session 也算管理员。 */
  isLocalUserAuthenticated?: RelayLocalAuthCheck;
  patchEnv?: (patch: Record<string, string>) => Promise<void>;
  log?: (line: string) => void;
};

export type RelayAdminAuth = {
  authorize(req: Request): Promise<boolean>;
  hasToken(): boolean;
};

function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1].trim();
  }
  const direct = req.headers.get('x-tmex-relay-admin-token');
  return direct?.trim() || null;
}

/**
 * 首启补齐管理令牌：
 * 1. env 给了就用 env 的（只把 hash 落库，方便运维核对）；
 * 2. 否则库里已有 hash 就沿用（令牌只在生成那次可见）；
 * 3. 否则生成一枚，尽力写进 app.env（production 才有 patchEnv），并打印一次。
 */
export async function ensureRelayAdminToken(opts: RelayAdminAuthOptions): Promise<string | null> {
  const now = opts.now();
  const current = opts.store.ensure(now);
  const configured = opts.configuredToken?.trim();
  const log = opts.log ?? ((line: string) => console.warn(line));
  if (configured) {
    const hash = sha256Hex(configured);
    if (current.adminTokenHash !== hash) opts.store.setAdminTokenHash(hash, now);
    return configured;
  }
  if (current.adminTokenHash) return null;
  const token = generateRelayAdminToken();
  opts.store.setAdminTokenHash(sha256Hex(token), now);
  let persisted = false;
  if (opts.patchEnv) {
    try {
      await opts.patchEnv({ TMEX_RELAY_ADMIN_TOKEN: token });
      persisted = true;
    } catch (err) {
      log(`[relay] failed to persist TMEX_RELAY_ADMIN_TOKEN: ${String(err)}`);
    }
  }
  log(
    persisted
      ? `[relay] generated admin token and wrote TMEX_RELAY_ADMIN_TOKEN to app.env: ${token}`
      : `[relay] generated admin token (not persisted, set TMEX_RELAY_ADMIN_TOKEN to keep it): ${token}`
  );
  return token;
}

export function createRelayAdminAuth(opts: RelayAdminAuthOptions): RelayAdminAuth {
  return {
    hasToken(): boolean {
      return Boolean(opts.configuredToken?.trim() || opts.store.read()?.adminTokenHash);
    },
    async authorize(req: Request): Promise<boolean> {
      const presented = bearerToken(req);
      if (presented) {
        const expected = opts.store.read()?.adminTokenHash ?? null;
        if (expected && constantTimeEqual(sha256Hex(presented), expected)) return true;
      }
      if (!opts.isLocalUserAuthenticated) return false;
      try {
        return await opts.isLocalUserAuthenticated(req);
      } catch {
        return false;
      }
    },
  };
}
