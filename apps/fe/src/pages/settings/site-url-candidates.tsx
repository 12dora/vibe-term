// 站点访问 URL 旁的候选地址：本机当前真正能被外部打开的入口（自建域名 / Hub / 中继 / 隧道 /
// 公网 IP），与分享地址同源同序。展示的是 `accessUrl`——含 `/n/<nodeId>` 转发前缀的完整地址，
// 直接填进设置或复制给别人都能用；只读（由 Hub 托管）时不给「填入」，仅供复制。

import type { ShareOriginCandidate } from '@vibeterm/shared/share';
import { Button } from '@vibeterm/ui/button';
import { useTranslation } from 'react-i18next';
import { CopyButton } from './nodes/copy-feedback';
import { originKindLabel } from './origin-kind-label';

function sameAddress(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** 与字段当前值相同的候选没有列出的意义（填入它等于什么都没做）。 */
export function visibleSiteUrlCandidates(
  candidates: readonly ShareOriginCandidate[],
  currentValue: string
): ShareOriginCandidate[] {
  return candidates.filter((candidate) => !sameAddress(candidate.accessUrl, currentValue));
}

export interface SiteUrlCandidateRowProps {
  candidate: ShareOriginCandidate;
  /** 种类前缀 + host，如「中继 · relay.example」。 */
  label: string;
  useLabel: string;
  testId: string;
  /** 可编辑时传入：点「填入」把该地址写进草稿。只读时不传，只留复制。 */
  onUse?: (accessUrl: string) => void;
}

/** 无 hook：测试可直接调用并驱动「填入」。 */
export function SiteUrlCandidateRow({
  candidate,
  label,
  useLabel,
  testId,
  onUse,
}: SiteUrlCandidateRowProps) {
  return (
    <li
      data-testid="settings-site-url-candidate"
      data-kind={candidate.kind}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-muted/40 px-2 py-1.5"
    >
      <span className="text-xs font-medium">{label}</span>
      <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-muted-foreground">
        {candidate.accessUrl}
      </code>
      {onUse && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => onUse(candidate.accessUrl)}
          data-testid="settings-site-url-candidate-use"
        >
          {useLabel}
        </Button>
      )}
      <CopyButton value={candidate.accessUrl} testId={testId} />
    </li>
  );
}

export interface SiteUrlCandidatesProps {
  candidates: readonly ShareOriginCandidate[];
  /** 字段当前的值：与它相同的候选不再重复列出。 */
  currentValue: string;
  onUse?: (accessUrl: string) => void;
}

export function SiteUrlCandidates({ candidates, currentValue, onUse }: SiteUrlCandidatesProps) {
  const { t } = useTranslation();
  const rows = visibleSiteUrlCandidates(candidates, currentValue);
  if (rows.length === 0) return null;

  return (
    <div className="space-y-1.5" data-testid="settings-site-url-candidates">
      <span className="block text-xs font-medium text-muted-foreground">
        {t(onUse ? 'settings.general.urlCandidates' : 'settings.general.urlOtherCandidates')}
      </span>
      <ul className="space-y-1">
        {rows.map((candidate, index) => (
          <SiteUrlCandidateRow
            key={candidate.accessUrl}
            candidate={candidate}
            label={originKindLabel(t, candidate)}
            useLabel={t('settings.general.urlUseCandidate')}
            testId={`settings-site-url-candidate-${index}`}
            onUse={onUse}
          />
        ))}
      </ul>
    </div>
  );
}
