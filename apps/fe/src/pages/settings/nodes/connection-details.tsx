// 「连接详情」：默认收起的那一段内部标识与用量。
//
// 这些字段（租户编号、本机编号、可访问节点、三档配额）排查时缺一不可，平时一个都不该占版面。
// **卡片其余部分不再重复其中任何一项**。

import type { UseMeshRelayResult } from '@/node/mesh-relay';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@vibeterm/ui/collapsible';
import { Progress } from '@vibeterm/ui/progress';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CopyableValue, Row } from './copy-feedback';
import { RelayPasswordRow } from './relay/relay-password-row';
import { type RelayQuotaRow, relayQuotaRows } from './relay/relay-quota';

export interface ConnectionDetailsProps {
  relay: UseMeshRelayResult;
  selfNodeId: string | null;
}

export function ConnectionDetails({ relay, selfNodeId }: ConnectionDetailsProps) {
  const { t } = useTranslation();
  return (
    <Collapsible data-testid="local-machine-details">
      <CollapsibleTrigger
        className="group/details flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        data-testid="local-machine-details-toggle"
      >
        <ChevronRight className="size-3.5 transition-transform duration-(--vibeterm-motion-fast) group-data-panel-open/details:rotate-90 motion-reduce:transition-none" />
        {t('nodes.machine.details.title')}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ConnectionDetailsContent relay={relay} selfNodeId={selfNodeId} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * 折叠区里的内容。单独导出且不自带 hook：Base UI 的 Collapsible 收起时压根不挂载面板，
 * 静态渲染什么都不输出，单测只能直接对内容做断言（与菜单那几处同一套做法）。
 */
export function ConnectionDetailsContent({ relay, selfNodeId }: ConnectionDetailsProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5 pt-2 text-xs" data-testid="local-machine-details-content">
      {relay.relayMode && relay.tenantId && (
        <Row label={t('relay.tenant.strip.tenantId')}>
          <CopyableValue value={relay.tenantId} testId="nodes-relay-tenant-id" mono />
          <span className="basis-full text-[11px] text-muted-foreground">
            {t('relay.tenant.strip.tenantIdHint')}
          </span>
        </Row>
      )}
      <RelayPasswordRow relay={relay} />
      {selfNodeId && (
        <Row label={t('nodes.machine.details.nodeId')}>
          <CopyableValue value={selfNodeId} testId="local-machine-node-id" mono />
        </Row>
      )}
      {relay.relayMode && <RelayDetails relay={relay} />}
    </div>
  );
}

function RelayDetails({ relay }: { relay: UseMeshRelayResult }) {
  const { t } = useTranslation();
  const quota = relay.quota;
  return (
    <>
      <Row label={t('nodes.machine.details.nodesViaRelay')}>
        <span data-testid="nodes-relay-peers">{relay.nodesViaRelay}</span>
      </Row>
      {quota &&
        relayQuotaRows(quota).map((row) => (
          <Row key={row.kind} label={t(row.labelKey)}>
            <QuotaValue row={row} />
          </Row>
        ))}
    </>
  );
}

function QuotaValue({ row }: { row: RelayQuotaRow }) {
  const { t } = useTranslation();
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
      <span data-testid={row.testId}>{quotaValueText(t, row)}</span>
      {row.percent !== null && (
        <span className="w-full min-w-0 max-w-40 sm:flex-1" data-testid={`${row.testId}-bar`}>
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
