import { CidrSet, EMPTY_CIDR_SET, parseCidrRule } from '../ip-cidr';

export { CidrSet, EMPTY_CIDR_SET };

/** 逗号或空白分隔的 IPv4 / IPv6 CIDR；裸地址视为 /32 或 /128。非法项启动失败。 */
export function parseTrustedProxyCidrs(raw: string | undefined): CidrSet {
  const entries: string[] = [];
  for (const entry of (raw ?? '').split(/[\s,]+/)) {
    if (!entry) continue;
    try {
      parseCidrRule(entry);
    } catch {
      throw new Error(`VIBETERM_TRUSTED_PROXY_CIDRS contains invalid CIDR ${entry}`);
    }
    entries.push(entry);
  }
  return entries.length === 0 ? EMPTY_CIDR_SET : new CidrSet(entries);
}
