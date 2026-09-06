// 候选地址只有 host，同时出现 Hub、中继、隧道、自建域名时分不清哪条是哪条，统一加种类前缀。
// 分享弹窗（packages/panels/src/share/share-origin-label.ts）另有同样的一份：`@tmex/panels`
// 没有导出 `./share` 子路径，两边只能各留一份，改文案时一起改。

import type { ShareOriginCandidate } from '@tmex/shared/share';

export function originKindLabel(
  t: (key: string) => string,
  candidate: Pick<ShareOriginCandidate, 'kind' | 'label'>
): string {
  return `${t(`common.originKind.${candidate.kind}`)} · ${candidate.label}`;
}
