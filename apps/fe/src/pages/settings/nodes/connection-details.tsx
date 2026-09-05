// 「连接详情」：默认收起的那一段内部标识与用量。
//
// 这些字段（租户编号、本机编号、可访问节点、三档配额、Hub 的优先级 / 纪元 / 授权 / 最近错误）
// 排查时缺一不可，平时一个都不该占版面。**卡片其余部分不再重复其中任何一项**：
// 以前同一个地址会在四五处露脸，谁也说不清哪一处才是当前生效的。
//
// 元数据密钥代数与密钥日志游标已经删掉：它们是引擎的内部游标，看得懂的人不看这里，
// 看不懂的人只会误以为出了问题。

import type { MeshHubsState } from '@/node/mesh-hubs';
import type { UseMeshRelayResult } from '@/node/mesh-relay';
import type { MeshHubEndpoint } from '@tmex/api-client/auth/index';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tmex/ui/collapsible';
import { Progress } from '@tmex/ui/progress';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyableValue } from './copy-feedback';
import { type RelayQuotaRow, relayQuotaRows } from './relay/relay-quota';
import {
  CANDIDATE_ERROR_MAX,
  candidateFailure,
  hubAuthorizationText,
  hubLabel,
  hubModeLabel,
  indexCandidates,
} from './uplink/hub-strip';

export interface ConnectionDetailsProps {
  relay: UseMeshRelayResult;
  hubs: MeshHubsState;
  selfNodeId: string | null;
}

export function ConnectionDetails({ relay, hubs, selfNodeId }: ConnectionDetailsProps) {
  const { t } = useTranslation();
  return (
    <Collapsible data-testid="local-machine-details">
      <CollapsibleTrigger
        className="group/details flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        data-testid="local-machine-details-toggle"
      >
        <ChevronRight className="size-3.5 transition-transform duration-(--tmex-motion-fast) group-data-panel-open/details:rotate-90 motion-reduce:transition-none" />
        {t('nodes.machine.details.title')}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ConnectionDetailsContent relay={relay} hubs={hubs} selfNodeId={selfNodeId} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * 折叠区里的内容。单独导出且不自带 hook：Base UI 的 Collapsible 收起时压根不挂载面板，
 * 静态渲染什么都不输出，单测只能直接对内容做断言（与菜单那几处同一套做法）。
 */
export function ConnectionDetailsContent({ relay, hubs, selfNodeId }: ConnectionDetailsProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5 pt-2 text-xs" data-testid="local-machine-details-content">
      {relay.relayMode && relay.tenantId && (
        <DetailRow
          label={t('relay.tenant.strip.tenantId')}
          hint={t('relay.tenant.strip.tenantIdHint')}
        >
          <CopyableValue value={relay.tenantId} testId="nodes-relay-tenant-id" mono />
        </DetailRow>
      )}
      {selfNodeId && (
        <DetailRow label={t('nodes.machine.details.nodeId')}>
          <CopyableValue value={selfNodeId} testId="local-machine-node-id" mono />
        </DetailRow>
      )}
      {relay.relayMode && <RelayDetails relay={relay} />}
      {hubs.hubs.length > 0 && <HubDetails hubs={hubs} />}
    </div>
  );
}

function RelayDetails({ relay }: { relay: UseMeshRelayResult }) {
  const { t } = useTranslation();
  const quota = relay.quota;
  return (
    <>
      <DetailRow label={t('nodes.machine.details.nodesViaRelay')}>
        <span data-testid="nodes-relay-peers">{relay.nodesViaRelay}</span>
      </DetailRow>
      {quota &&
        relayQuotaRows(quota).map((row) => (
          <DetailRow key={row.kind} label={t(row.labelKey)}>
            <QuotaValue row={row} />
          </DetailRow>
        ))}
    </>
  );
}

function QuotaValue({ row }: { row: RelayQuotaRow }) {
  const { t } = useTranslation();
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span data-testid={row.testId}>{quotaValueText(t, row)}</span>
      {row.percent !== null && (
        <span className="max-w-40 flex-1" data-testid={`${row.testId}-bar`}>
          <Progress value={row.percent} />
        </span>
      )}
    </span>
  );
}

/**
 * 「已用 / 上限」。无上限那一档不能套 `{{used}} / {{total}}`：
 * 「不限」本身不是个数，摆出来就成了「4.00 KB/s / 不限」两道斜杠。
 */
function quotaValueText(
  t: (key: string, options?: Record<string, unknown>) => string,
  row: RelayQuotaRow
): string {
  if (row.usedText === null) return row.limitKey ? t(row.limitKey) : (row.limitText ?? '');
  if (row.limitKey) {
    return t('nodes.machine.details.quotaUnlimitedValue', { used: row.usedText });
  }
  return t('nodes.machine.details.quotaValue', {
    used: row.usedText,
    total: row.limitText ?? '',
  });
}

function HubDetails({ hubs }: { hubs: MeshHubsState }) {
  const { t } = useTranslation();
  const byUrl = indexCandidates(hubs.candidates);
  return (
    <DetailRow label={t('nodes.machine.details.hubs')}>
      <span
        className="flex min-w-0 flex-1 flex-col gap-1.5"
        data-testid="local-machine-hub-details"
      >
        {hubs.hubs.map((hub) => (
          <HubDetailLines
            key={hub.nodeId}
            hub={hub}
            attached={hub.nodeId === hubs.attached?.hubNodeId}
            writer={hub.nodeId === hubs.writerHubId}
            failure={candidateFailure(hub, byUrl)}
          />
        ))}
      </span>
    </DetailRow>
  );
}

function HubDetailLines({
  hub,
  attached,
  writer,
  failure,
}: {
  hub: MeshHubEndpoint;
  attached: boolean;
  writer: boolean;
  failure: ReturnType<typeof candidateFailure>;
}) {
  const { t } = useTranslation();
  const authorization = hubAuthorizationText(t, hub);
  return (
    <span className="flex flex-col gap-0.5" data-testid={`local-machine-hub-detail-${hub.nodeId}`}>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-medium">{hubLabel(hub)}</span>
        <span className="text-muted-foreground">{hubModeLabel(t, hub.mode)}</span>
        {attached && <span className="text-primary">{t('nodes.hubs.attached')}</span>}
        {writer && <span className="text-muted-foreground">{t('nodes.hubs.writer')}</span>}
      </span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
        <span>{`${t('nodes.hubs.priority')} ${hub.priority}`}</span>
        <span>{`${t('nodes.hubs.epoch')} ${hub.writerEpoch}`}</span>
        {authorization && <span>{authorization}</span>}
      </span>
      {failure && (
        <span className="break-all text-destructive">
          {t('nodes.hubs.lastError', {
            error: (failure.lastError ?? '').slice(0, CANDIDATE_ERROR_MAX),
          })}
          {failure.lastAttemptAt
            ? ` · ${t('nodes.hubs.lastAttempt', {
                time: new Date(failure.lastAttemptAt).toLocaleString(),
              })}`
            : ''}
        </span>
      )}
    </span>
  );
}

function DetailRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-2">
      <span className="w-32 shrink-0 pt-0.5 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {children}
        {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </span>
    </div>
  );
}
