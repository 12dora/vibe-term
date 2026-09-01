// WebCrypto 的 Ed25519：用来生成**不可导出**（non-extractable）的浏览器会话钥 `sk_sess`。
//
// 与 `./root-key` 的 `@noble` 实现是同一套算法、同样的 32 字节 raw 公钥与 64 字节签名，
// `verifyEd25519()`（node 侧验签用的那一个）可以直接验 `signWithWebCryptoEd25519()` 的输出。
// 区别只在私钥的归属：这里的私钥是浏览器持有的 `CryptoKey`，JS 拿不到它的字节，因而可以
// 结构化克隆进 IndexedDB 而不落盘任何密钥材料。
//
// Safari 17+ / Chrome 137+ / Firefox 130+ 支持；不支持的环境由调用方回退到 `@noble` 路径。

const ALGORITHM = 'Ed25519';

export interface WebCryptoEd25519KeyPair {
  /** 不可导出的私钥：只能交给 `signWithWebCryptoEd25519()`。 */
  privateKey: CryptoKey;
  /** raw 32 字节公钥。 */
  publicKey: Uint8Array;
}

function requireSubtle(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto subtle is unavailable');
  return subtle;
}

/** 生成一对 Ed25519 钥；私钥不可导出。环境不支持 Ed25519 时抛错，由调用方回退。 */
export async function generateWebCryptoEd25519KeyPair(): Promise<WebCryptoEd25519KeyPair> {
  const subtle = requireSubtle();
  const pair = (await subtle.generateKey({ name: ALGORITHM }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = await subtle.exportKey('raw', pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(raw) };
}

/** 用不可导出私钥签名，输出与 `signEd25519()` 完全一致的 64 字节签名。 */
export async function signWithWebCryptoEd25519(
  privateKey: CryptoKey,
  message: Uint8Array
): Promise<Uint8Array> {
  const signature = await requireSubtle().sign(ALGORITHM, privateKey, message as BufferSource);
  return new Uint8Array(signature);
}
