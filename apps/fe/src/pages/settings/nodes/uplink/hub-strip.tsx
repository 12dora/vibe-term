// Hub chip 的共用零件：主 / 备文案、悬浮详情、候选地址诊断。
//
// chip 本体由本机卡的「接入 Hub」面板渲染（`hub-uplink-panel.tsx`），节点表与节点详情
// 只借这里的文案函数。

import type { MeshHubCandidate } from '@/node/mesh-hubs';
import type {
  HubAuthorizationKind,
  HubEndpointInfo,
  HubMode,
  MeshHubEndpoint,
} from '@tmex/api-client/auth/index';
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
