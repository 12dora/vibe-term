// 会话密钥对的生成与 login 签名（登录与签发登录命令共用，随登录 chunk 懒加载）。

import type { Login } from '@vibeterm/shared/auth';
import {
  encodeLogin,
  generateEd25519KeyPair,
  generateWebCryptoEd25519KeyPair,
  signLogin,
  signWithWebCryptoEd25519,
} from '@vibeterm/shared/auth';
import type { SessionKeySecrets } from './session-key-types';

export interface SessionKeyMaterial {
  publicKey: Uint8Array;
  /** WebCrypto 路径的不可导出私钥。 */
  cryptoKey: CryptoKey | null;
  /** `@noble` 回退路径的原始私钥。 */
  secretKey: Uint8Array | null;
  /** 没能交给 session store 时就地清零（只有 `@noble` 路径有字节要清）。 */
  destroy(): void;
}

/** WebCrypto 的 Ed25519 是否可用；不可用（老 Safari / 老 Chrome）探测一次就记住。 */
let webCryptoEd25519 = true;

/**
 * 生成 `sk_sess`。
 *
 * 首选 WebCrypto 的**不可导出**私钥：私钥字节从不进 JS，因而可以整把存进 IndexedDB，让 PWA
 * 冷启动后还能静默登录别的 node。不支持 Ed25519 的环境回退到 `@noble` 的原始私钥——那条路径
 * 只留内存，行为与改造前完全一致。
 */
export async function generateSessionKeyMaterial(
  override?: () => { publicKey: Uint8Array; secretKey: Uint8Array }
): Promise<SessionKeyMaterial> {
  if (!override && webCryptoEd25519) {
    try {
      const pair = await generateWebCryptoEd25519KeyPair();
      return {
        publicKey: pair.publicKey,
        cryptoKey: pair.privateKey,
        secretKey: null,
        destroy: () => undefined,
      };
    } catch {
      webCryptoEd25519 = false;
    }
  }
  const pair = (override ?? generateEd25519KeyPair)();
  return {
    publicKey: pair.publicKey,
    cryptoKey: null,
    secretKey: pair.secretKey,
    destroy: () => pair.secretKey.fill(0),
  };
}

/** 两条私钥形态共用的 login 签名；输出都是标准 64 字节 Ed25519 签名，node 侧无差别。 */
export function signSessionLogin(
  secrets: Pick<SessionKeySecrets, 'sessKey' | 'sessSk'>,
  login: Login
): Promise<Uint8Array> {
  if (secrets.sessKey) return signWithWebCryptoEd25519(secrets.sessKey, encodeLogin(login));
  if (!secrets.sessSk) return Promise.reject(new Error('session key material is gone'));
  return Promise.resolve(signLogin(secrets.sessSk, login));
}
