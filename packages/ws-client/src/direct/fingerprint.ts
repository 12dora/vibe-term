// DTLS 指纹的解析与规范化（设计 §3「直连授权」）。
//
// 这是挡「失陷 hub 做 DTLS 中间人」的那道绑定，解析必须按 [RFC 8122] 的作用域规则来：
// `a=fingerprint` 既可出现在 session 级（第一条 `m=` 之前），也可出现在 media 级，
// **media 级覆盖同名 session 级**。只取 SDP 里第一条 `a=fingerprint` 会被这样绕过：
// session 级放合法的 `fp_node`、`m=application` 段里塞攻击者证书的指纹，比较通过而
// DTLS 实际用攻击者的证书。
//
// 因此本模块只认 `m=application` 段（DataChannel 唯一会用的 media 段）的**有效指纹**：
//   1. 该段自己有 `a=fingerprint` → 只用该段的；
//   2. 该段没有 → 回落 session 级；
//   3. 有效集合去重后必须**恰好一条 sha-256**，冲突或多余（含多算法并存、多个
//      `m=application` 段）一律返回 `null`，由调用方放弃本次直连。
//
// 与 `@tmex/shared/auth` 的 `parseSdpFingerprint` **刻意不同**：后者是宽松的首条匹配。
// 这里重写而不复用 shared，是不让 ws-client 为了两个正则把 argon2 wasm / noble 曲线
// 拖进前端 bundle；`normalizeFingerprint` 的语义仍与 shared 逐字段一致（有对拍用例）。
//
// [RFC 8122]: https://www.rfc-editor.org/rfc/rfc8122.html

export interface DtlsFingerprint {
  /** 小写算法名，如 `sha-256` */
  algorithm: string;
  /** 大写十六进制、去掉冒号与空白 */
  value: string;
}

/** 本协议只接受 sha-256：node 侧 `fp_node` 也只按该算法登记。 */
export const REQUIRED_FINGERPRINT_ALGORITHM = 'sha-256';

const FINGERPRINT_LINE = /^a=fingerprint:(\S+)[ \t]+([0-9A-Fa-f:]+)$/;

export function normalizeFingerprint(fp: { algorithm: string; value: string }): DtlsFingerprint {
  return {
    algorithm: fp.algorithm.trim().toLowerCase(),
    value: fp.value.replace(/[:\s]/g, '').toUpperCase(),
  };
}

interface MediaSection {
  /** `m=` 后的媒体类型，如 `application` / `audio` */
  kind: string;
  lines: string[];
}

interface SdpSections {
  session: string[];
  media: MediaSection[];
}

function splitSections(sdp: string): SdpSections {
  const session: string[] = [];
  const media: MediaSection[] = [];
  let current: MediaSection | null = null;
  for (const raw of sdp.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('m=')) {
      current = { kind: line.slice(2).split(/[ \t]/)[0] ?? '', lines: [] };
      media.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else session.push(line);
  }
  return { session, media };
}

function fingerprintsIn(lines: string[]): DtlsFingerprint[] {
  const out: DtlsFingerprint[] = [];
  for (const line of lines) {
    const match = FINGERPRINT_LINE.exec(line);
    if (!match) continue;
    const algorithm = match[1];
    const value = match[2];
    if (algorithm === undefined || value === undefined || value.length === 0) continue;
    out.push(normalizeFingerprint({ algorithm, value }));
  }
  return out;
}

function distinct(fingerprints: DtlsFingerprint[]): DtlsFingerprint[] {
  const byKey = new Map<string, DtlsFingerprint>();
  for (const fp of fingerprints) byKey.set(`${fp.algorithm} ${fp.value}`, fp);
  return [...byKey.values()];
}

/**
 * 取 SDP 中 `m=application` 段实际生效的 sha-256 指纹；任何歧义都返回 `null`（拒绝直连）。
 * 本地 offer 与远端 answer 用的是同一个解析器。
 */
export function parseSdpFingerprint(sdp: string): DtlsFingerprint | null {
  const { session, media } = splitSections(sdp);
  const application = media.filter((section) => section.kind === 'application');
  // 多个 DataChannel media 段无法判定载体实际用哪一条；没有 application 段（只有音视频）
  // 也不是本协议的 SDP。两种情况都不猜。
  if (application.length > 1) return null;
  if (media.length > 0 && application.length === 0) return null;

  const target = application[0];
  const mediaLevel = target ? fingerprintsIn(target.lines) : [];
  // RFC 8122：media 级存在即覆盖 session 级，不做并集。
  const effective = distinct(mediaLevel.length > 0 ? mediaLevel : fingerprintsIn(session));
  if (effective.length !== 1) return null;
  const fp = effective[0];
  if (!fp || fp.algorithm !== REQUIRED_FINGERPRINT_ALGORITHM) return null;
  return fp;
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
