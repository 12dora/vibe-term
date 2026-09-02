// Hub 集群条：一台 hub 一枚 chip，正文只写「名字 + 主 / 备」，在线态、写入归属与挂载关系
// 分别落在状态点、图标与悬浮详情里。
//
// 只有两台及以上 hub 才渲染：单 hub 用户（绝大多数）看到的版式与多 hub 之前完全一致。

import type { MeshHubCandidate } from '@/node/mesh-hubs';
import type {
  HubAuthorizationKind,
  HubEndpointInfo,
  HubMode,
  MeshHubEndpoint,
} from '@tmex/api-client/auth/index';
import { cn } from '@tmex/ui';
import { Link2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 主 / 备的文案键；旧后端不下发 mode 时退回通用的「Hub」。 */
export function hubModeLabel(t: Translate, mode: HubMode | null): string {
  if (mode === 'active') return t('nodes.hubs.active');
  if (mode === 'standby') return t('nodes.hubs.standby');
  return t('nodes.hub');
}

/** chip 与表内徽标共用的悬浮详情：地址、优先级、写入纪元、在线态。 */
export function hubDetailText(t: Translate, hub: HubEndpointInfo, attached: boolean): string {
  const detail = t('nodes.hubs.detail', {
    url: hub.publicUrl,
    priority: hub.priority,
    epoch: hub.writerEpoch,
    state: t(hub.online === false ? 'nodes.hubs.offline' : 'nodes.hubs.online'),
  });
  return attached ? `${detail}\n${t('nodes.hubs.attached')}` : detail;
}

/** hub 的短名：没有名字时用 nodeId 前 8 位，与指纹列的读法一致。 */
export function hubLabel(hub: HubEndpointInfo): string {
  return hub.name || hub.nodeId.slice(0, 8);
}

/** 主 / 备的小徽标：与节点表里的 hub 徽标同一版式，供本机区块复用。 */
export function HubModeTag({ mode, testId }: { mode: HubMode | null; testId?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className="rounded border border-border px-1 py-px text-[10px] text-muted-foreground"
      data-testid={testId}
      data-hub-mode={mode ?? ''}
    >
      {hubModeLabel(t, mode)}
    </span>
  );
}

/** uplink 候选地址的错误提示上限：title 里塞一整段栈没有意义，只留够定位的一截。 */
export const CANDIDATE_ERROR_MAX = 160;

/** 归一化对外地址：只差一个末尾斜杠的两个地址指的是同一台 hub。 */
export function normalizeHubUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** 按归一化地址索引候选记录；同一地址多条时后来的覆盖前面的。 */
export function indexCandidates(
  candidates: MeshHubCandidate[]
): ReadonlyMap<string, MeshHubCandidate> {
  return new Map(candidates.map((row) => [normalizeHubUrl(row.publicUrl), row]));
}

/** 这台 hub 最近一次连接失败的诊断；没有失败记录返回 `null`。 */
export function candidateFailure(
  hub: HubEndpointInfo,
  byUrl: ReadonlyMap<string, MeshHubCandidate>
): MeshHubCandidate | null {
  const candidate = byUrl.get(normalizeHubUrl(hub.publicUrl));
  return candidate?.lastError ? candidate : null;
}

const AUTHORIZATION_KEYS: Record<HubAuthorizationKind, string> = {
  signed: 'nodes.hubs.authorization.signed',
  env: 'nodes.hubs.authorization.env',
  self: 'nodes.hubs.authorization.self',
  none: 'nodes.hubs.authorization.none',
};

/** 入口凭什么认这台 hub（签名授权 / 环境变量 / 本机）；旧后端不下发时不出这一行。 */
export function hubAuthorizationText(t: Translate, hub: MeshHubEndpoint): string | null {
  const key = hub.authorization ? AUTHORIZATION_KEYS[hub.authorization] : undefined;
  return key ? t('nodes.hubs.authorization.label', { value: t(key) }) : null;
}

/**
 * chip 的悬浮详情：地址那一行 + 写入归属 + 授权来源，最近连不上时再补「最近尝试 / 最近错误」两行。
 * chip 本体只留「名字 + 主 / 备」，写入与挂载这类次要信息一律收进 title。
 */
export function hubChipTitle(
  t: Translate,
  hub: MeshHubEndpoint,
  attached: boolean,
  failure: MeshHubCandidate | null,
  writer = false
): string {
  const lines = [hubDetailText(t, hub, attached)];
  if (writer) lines.push(t('nodes.hubs.writer'));
  const authorization = hubAuthorizationText(t, hub);
  if (authorization) lines.push(authorization);
  if (failure) {
    const at = failure.lastAttemptAt ? new Date(failure.lastAttemptAt).toLocaleString() : '—';
    lines.push(t('nodes.hubs.lastAttempt', { time: at }));
    lines.push(
      t('nodes.hubs.lastError', { error: (failure.lastError ?? '').slice(0, CANDIDATE_ERROR_MAX) })
    );
  }
  return lines.join('\n');
}

export function HubStrip({
  hubs,
  attachedHubId,
  writerHubId,
  candidates = [],
}: {
  hubs: MeshHubEndpoint[];
  attachedHubId: string | null;
  writerHubId: string | null;
  candidates?: MeshHubCandidate[];
}) {
  const { t } = useTranslation();
  const byUrl = indexCandidates(candidates);
  if (hubs.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="nodes-hub-strip">
      <span className="text-[11px] text-muted-foreground">{t('nodes.hubs.title')}</span>
      {hubs.map((hub) => (
        <HubChip
          key={hub.nodeId}
          hub={hub}
          attached={hub.nodeId === attachedHubId}
          writer={hub.nodeId === writerHubId}
          failure={candidateFailure(hub, byUrl)}
        />
      ))}
    </div>
  );
}

function HubChip({
  hub,
  attached,
  writer,
  failure,
}: {
  hub: MeshHubEndpoint;
  attached: boolean;
  writer: boolean;
  failure: MeshHubCandidate | null;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
        attached ? 'border-primary/50 bg-primary/5' : 'border-border/60'
      )}
      title={hubChipTitle(t, hub, attached, failure, writer)}
      data-testid={`nodes-hub-chip-${hub.nodeId}`}
      data-hub-mode={hub.mode}
      data-hub-attached={attached ? 'true' : 'false'}
      data-hub-writer={writer ? 'true' : 'false'}
      data-hub-failing={failure ? 'true' : 'false'}
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          hub.online === false ? 'bg-muted-foreground/40' : 'bg-emerald-500'
        )}
      />
      <span className="truncate font-medium">{hubLabel(hub)}</span>
      <span className="text-muted-foreground">{hubModeLabel(t, hub.mode)}</span>
      {failure && (
        <TriangleAlert
          className="size-3 shrink-0 text-amber-500"
          data-testid={`nodes-hub-warning-${hub.nodeId}`}
          aria-hidden
        />
      )}
      {attached && <Link2 className="size-3 shrink-0 text-primary" aria-hidden />}
    </span>
  );
}
