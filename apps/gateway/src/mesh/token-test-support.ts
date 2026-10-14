import type { AccessTokenScope } from '@vibeterm/shared';
import { AccessTokenService, bindAccessTokenService } from '../auth/access-tokens';
import { createMigratedAuthDb } from '../auth/test-db';
import { users } from '../db/schema';

export const TOKEN_USER = 'tok-user';

export type TokenFixture = {
  service: AccessTokenService;
  setNow: (value: number) => void;
  mint: (
    scopes: AccessTokenScope[],
    expiresInDays?: number | null
  ) => { id: string; secret: string };
  close: () => void;
};

/** 令牌服务绑定到独立的内存库（带属主用户），时钟可控。 */
export function bootTokenFixture(): TokenFixture {
  const { db, close } = createMigratedAuthDb();
  db.insert(users)
    .values({
      id: TOKEN_USER,
      username: 'token-user',
      rootPublicKey: Buffer.alloc(32, 1),
      rootEpoch: 0,
      kdfParamsJson: '{}',
      totpRecordSeq: null,
      keyLogHeadSeq: 0,
      keyLogHeadHash: Buffer.alloc(32, 2),
      createdAt: 0,
      updatedAt: 0,
    })
    .run();
  let now = 1_800_000_000_000;
  const service = new AccessTokenService(db, { now: () => now });
  bindAccessTokenService(service);
  return {
    service,
    setNow: (value) => {
      now = value;
    },
    mint: (scopes, expiresInDays = null) => {
      const created = service.create(TOKEN_USER, { name: 'ci', scopes, expiresInDays });
      return { id: created.token.id, secret: created.secret };
    },
    close: () => {
      bindAccessTokenService(null);
      close();
    },
  };
}
