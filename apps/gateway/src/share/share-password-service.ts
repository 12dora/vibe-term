import { SHARE_PASSWORD_MIN_LENGTH } from '@vibeterm/shared/share';
import { decryptWithContext, encrypt } from '../crypto';
import { type ShareRow, type ShareStore, hashSharePassword } from './share-store';
import type { SharePasswordResult, ShareServiceDeps } from './types';

export type SharePasswordWriteResult =
  | { ok: true; row: ShareRow; endedSessions: number }
  | { ok: false; code: 'SHARE_NOT_FOUND' | 'SHARE_ENDED' | 'SHARE_PASSWORD_TOO_SHORT' };

type SharePasswordDeps = Pick<
  ShareServiceDeps,
  'hashPassword' | 'encryptPassword' | 'decryptPassword'
>;

/**
 * 口令的两份存储：`password_hash`（argon2id，登录校验用）与 `password_enc`（AES-256-GCM
 * 主密钥加密，站长回显用）。0048 之前创建的分享只有哈希，回显时报 SHARE_PASSWORD_UNAVAILABLE。
 */
export class SharePasswordManager {
  constructor(
    private readonly store: ShareStore,
    private readonly deps: SharePasswordDeps
  ) {}

  hash(password: string): Promise<string> {
    return (this.deps.hashPassword ?? hashSharePassword)(password);
  }

  encrypt(password: string): Promise<string> {
    return (this.deps.encryptPassword ?? encrypt)(password);
  }

  private decrypt(ciphertext: string, shareId: string): Promise<string> {
    if (this.deps.decryptPassword) return this.deps.decryptPassword(ciphertext, shareId);
    return decryptWithContext(ciphertext, { scope: 'share', entityId: shareId, field: 'password' });
  }

  async read(id: string): Promise<SharePasswordResult> {
    if (!this.store.get(id)) return { ok: false, code: 'SHARE_NOT_FOUND' };
    const ciphertext = this.store.passwordEnc(id);
    if (!ciphertext) return { ok: false, code: 'SHARE_PASSWORD_UNAVAILABLE' };
    // 主密钥不匹配是部署故障，不是「不可回显」：让 CryptoDecryptError 冒到路由层报 500。
    return { ok: true, password: await this.decrypt(ciphertext, id) };
  }

  /** `onRevoked` 只在踢人时调用，用于让服务层广播 ShareSessionsRevokedEvent。 */
  async write(
    id: string,
    password: string,
    options: { endSessions: boolean; onRevoked: (shareId: string) => void }
  ): Promise<SharePasswordWriteResult> {
    const existing = this.store.get(id);
    if (!existing) return { ok: false, code: 'SHARE_NOT_FOUND' };
    if (existing.state !== 'active') return { ok: false, code: 'SHARE_ENDED' };
    if ((password ?? '').length < SHARE_PASSWORD_MIN_LENGTH) {
      return { ok: false, code: 'SHARE_PASSWORD_TOO_SHORT' };
    }
    const [hash, enc] = await Promise.all([this.hash(password), this.encrypt(password)]);
    if (!this.store.updatePassword(id, hash, enc)) return { ok: false, code: 'SHARE_NOT_FOUND' };
    let endedSessions = 0;
    if (options.endSessions) {
      endedSessions = this.store.deleteAccessTokensByShare(id);
      options.onRevoked(id);
    }
    return { ok: true, row: this.store.get(id) ?? existing, endedSessions };
  }
}
