// 候选地址在下拉里只有 host，同时出现 Hub、中继、隧道、自建域名时分不清哪条是哪条，
// 因此统一加一个种类前缀。
// 设置页（apps/fe/src/pages/settings/origin-kind-label.ts）另有同样的一份：`@vibeterm/panels`
// 没有导出 `./share` 子路径，两边只能各留一份，改文案时一起改。

import type { ShareOriginCandidate } from '@vibeterm/shared/share';

export function shareOriginLabel(
  t: (key: string) => string,
  candidate: ShareOriginCandidate
): string {
  return `${t(`common.originKind.${candidate.kind}`)} · ${candidate.label}`;
}
