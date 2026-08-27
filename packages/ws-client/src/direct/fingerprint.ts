// DTLS 指纹的解析与规范化（设计 §3「直连授权」）。
//
// 语义与 `@tmex/shared/auth` 的 `parseSdpFingerprint / normalizeFingerprint` 完全一致
// （`fingerprint.test.ts` 用同一批向量与 shared 实现对拍）。这里重写一份的唯一理由是
// 不让 ws-client 为了两个正则把 `@tmex/shared/auth`（argon2 wasm、noble 曲线）拖进前端 bundle。

export interface DtlsFingerprint {
  /** 小写算法名，如 `sha-256` */
  algorithm: string;
  /** 大写十六进制、去掉冒号与空白 */
  value: string;
}

export function normalizeFingerprint(fp: { algorithm: string; value: string }): DtlsFingerprint {
  return {
    algorithm: fp.algorithm.trim().toLowerCase(),
    value: fp.value.replace(/[:\s]/g, '').toUpperCase(),
  };
}

/** 从 SDP 里取 `a=fingerprint:<alg> <value>`；取不到返回 `null`。 */
export function parseSdpFingerprint(sdp: string): DtlsFingerprint | null {
  const match = sdp.match(/(?:^|\r?\n)a=fingerprint:([^\s]+)\s+([0-9A-Fa-f:]+)\s*$/im);
  if (!match) return null;
  const algorithm = match[1];
  const value = match[2];
  if (algorithm === undefined || value === undefined) return null;
  return normalizeFingerprint({ algorithm, value });
}

export function fingerprintsEqual(
  a: { algorithm: string; value: string } | null | undefined,
  b: { algorithm: string; value: string } | null | undefined
): boolean {
  if (!a || !b) return false;
  const left = normalizeFingerprint(a);
  const right = normalizeFingerprint(b);
  return left.algorithm === right.algorithm && left.value === right.value;
}
