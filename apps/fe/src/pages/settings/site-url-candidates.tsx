// 站点访问 URL 旁的候选地址：本机当前真正能被外部打开的入口（自建域名 / 中继 / 隧道 /
// 公网 IP），与分享地址同源同序。做成单选组：只画「种类 · host」，完整的 `accessUrl`（含
// `/n/<nodeId>` 转发前缀）挂在 title 与 sr-only 上——窄屏铺开长 URL 会折成三四行。
// 点一下即把完整地址写进草稿，保存仍走下方的保存按钮。
// 原生 radio + 自绘胶囊：分组语义、方向键切换、读屏播报全部白拿（同 connect-devices 的地址选择）。

import type { ShareOriginCandidate } from '@vibeterm/shared/share';
import { useTranslation } from 'react-i18next';
import { originKindLabel } from './origin-kind-label';

/** 比较用：去掉末尾斜杠，host 大小写不敏感（path 仍区分大小写）。 */
function normalizeAddress(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}${url.hash}`;
  } catch {
    return trimmed;
  }
}

const PILL_BASE =
  'inline-flex min-w-0 max-w-full items-center rounded-full border px-2.5 py-1 text-xs transition-colors duration-(--vibeterm-motion-fast) ease-out has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring motion-reduce:transition-none';

export function visibleSiteUrlCandidates(
  candidates: readonly ShareOriginCandidate[]
): ShareOriginCandidate[] {
  const claimed = new Set<string>();
  for (const item of candidates) {
    if (item.kind === 'site') continue;
    const key = normalizeAddress(item.accessUrl);
    if (key) claimed.add(key);
  }
  const seen = new Set<string>();
  const visible: ShareOriginCandidate[] = [];
  for (const candidate of candidates) {
    const key = normalizeAddress(candidate.accessUrl);
    if (candidate.kind === 'site' && claimed.has(key)) continue;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    visible.push(candidate);
  }
  return visible;
}

function pillClassName(selected: boolean, interactive: boolean): string {
  const state = selected
    ? 'border-primary/60 bg-primary/10 font-medium text-foreground'
    : 'border-border/60 bg-muted/40 text-muted-foreground';
  const mode = interactive
    ? `cursor-pointer${selected ? '' : ' hover:bg-muted'}`
    : 'cursor-default';
  return `${PILL_BASE} ${state} ${mode}`;
}

export interface SiteUrlCandidateOptionProps {
  candidate: ShareOriginCandidate;
  /** 种类前缀 + host，如「中继 · relay.example」。 */
  label: string;
  selected: boolean;
  /** 可编辑时传入：点选把该地址写进草稿。只读时不传，整颗只用来标出生效地址。 */
  onSelect?: (accessUrl: string) => void;
}

/** 无 hook：测试可直接调用并驱动点选。 */
export function SiteUrlCandidateOption({
  candidate,
  label,
  selected,
  onSelect,
}: SiteUrlCandidateOptionProps) {
  const interactive = Boolean(onSelect);
  return (
    <label
      title={candidate.accessUrl}
      aria-disabled={interactive ? undefined : true}
      data-testid="settings-site-url-candidate"
      data-kind={candidate.kind}
      data-selected={selected ? 'true' : 'false'}
      className={pillClassName(selected, interactive)}
    >
      <input
        type="radio"
        name="site-url-candidate"
        value={candidate.accessUrl}
        checked={selected}
        disabled={!interactive}
        onChange={() => onSelect?.(candidate.accessUrl)}
        data-testid="settings-site-url-candidate-radio"
        className="sr-only"
      />
      <span className="truncate">{label}</span>
      <span className="sr-only">{candidate.accessUrl}</span>
    </label>
  );
}

export interface SiteUrlCandidatesProps {
  candidates: readonly ShareOriginCandidate[];
  /** 字段当前的值：与它相同的候选标为选中；都对不上（自己敲的地址）时无选中项。 */
  currentValue: string;
  onSelect?: (accessUrl: string) => void;
}

export function SiteUrlCandidates({ candidates, currentValue, onSelect }: SiteUrlCandidatesProps) {
  const { t } = useTranslation();
  const visible = visibleSiteUrlCandidates(candidates);
  if (visible.length === 0) return null;
  const current = normalizeAddress(currentValue);
  const title = t('settings.general.urlCandidates');

  return (
    <div className="space-y-1.5" data-testid="settings-site-url-candidates">
      <span className="block text-xs font-medium text-muted-foreground">{title}</span>
      <div role="radiogroup" aria-label={title} className="flex flex-wrap gap-1.5">
        {visible.map((candidate) => (
          <SiteUrlCandidateOption
            key={`${candidate.kind}:${candidate.accessUrl}`}
            candidate={candidate}
            label={originKindLabel(t, candidate)}
            selected={current !== '' && normalizeAddress(candidate.accessUrl) === current}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}
