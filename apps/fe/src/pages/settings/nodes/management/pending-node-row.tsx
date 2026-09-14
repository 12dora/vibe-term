// 节点表里的「待同步」行：中继 `pendingMemberIds` 里还不在 mesh 列表的占位。
//
// 已 admit 但名字 / inventory 仍为空（状态块未解开），因此没有 peer link、没有版本、
// 也没有可吊销的证书：整行禁用，只展示名称 / 状态 / 地址。

import { RecordCard, RecordCardMeta } from '@/components/record-card';
import { TONE_CLASS } from '@/lib/tone';
import type { NodeRow } from '@/node/mesh-nodes';
import { buildNodeView } from '@/node/node-view-model';
import { Button } from '@vibeterm/ui/button';
import { Checkbox } from '@vibeterm/ui/checkbox';
import { Ellipsis, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { stickyActionColumn } from '../../components/wide-table';
import { Td, displayAddress, rowBlockedHint } from './row-cells';
import type { NodeActionDeps } from './types';

/**
 * 待同步行：已 admit 但名字 / inventory 仍为空。
 * 没有 peer link、没有版本、也没有可吊销的证书，整行禁用；
 * 勾选框同样禁用，批量升级 / 移除都碰不到它。
 */
export function PendingNodeRow({ row, ...deps }: { row: NodeRow } & NodeActionDeps) {
  const { t } = useTranslation();
  const blocked = deps.uplinkWritable ? t('nodes.status.pending') : rowBlockedHint(t, deps);
  const view = buildNodeView(row, t, 0);

  return (
    <tr className="border-b border-border/60 last:border-0" data-testid={`nodes-row-${row.id}`}>
      <td className="px-2 py-2 align-middle">
        <Checkbox checked={false} disabled aria-label={row.name} />
      </td>
      <Td>
        <span className="truncate font-medium">{row.name}</span>
      </Td>
      <Td>
        <span
          className={TONE_CLASS.text[view.statusTone]}
          data-testid={`nodes-status-${row.id}`}
          data-admission="pending"
        >
          {view.statusText}
        </span>
      </Td>
      <Td>
        <span data-testid={`nodes-reach-${row.id}`}>{view.reachText}</span>
      </Td>
      <Td>—</Td>
      <Td>
        <code
          className="block max-w-[14rem] truncate font-mono text-[11px] text-muted-foreground"
          title={view.addressText}
          data-testid={`nodes-address-${row.id}`}
        >
          {view.addressText}
        </code>
      </Td>
      <Td>{t('common.no')}</Td>
      <Td className={stickyActionColumn}>
        <div className="flex items-start gap-1">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled
            title={blocked}
            data-testid={`node-more-${row.id}`}
          >
            <Ellipsis />
            {t('nodes.actions.more')}
          </Button>
          <Button type="button" size="xs" variant="destructive" disabled title={blocked}>
            <ShieldAlert />
            {t('nodes.actions.revoke')}
          </Button>
        </div>
      </Td>
    </tr>
  );
}

/** 待同步行在 sm 以下的版式：勾选（禁用）+ 名称、状态 · 连接方式、地址。 */
export function PendingNodeCard({ row }: { row: NodeRow }) {
  const { t } = useTranslation();
  const view = buildNodeView(row, t, 0);
  const address = displayAddress(row.address);

  return (
    <RecordCard testId={`nodes-row-${row.id}`}>
      <div className="flex items-start gap-2">
        <Checkbox className="mt-0.5" checked={false} disabled aria-label={row.name} />
        <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
      </div>
      <RecordCardMeta>
        <span
          className={TONE_CLASS.text[view.statusTone]}
          data-testid={`nodes-status-${row.id}`}
          data-admission="pending"
        >
          {view.statusText}
        </span>
        <span data-testid={`nodes-reach-${row.id}`}>{view.reachText}</span>
      </RecordCardMeta>
      {address && (
        <code
          className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
          title={address}
          data-testid={`nodes-address-${row.id}`}
        >
          {address}
        </code>
      )}
    </RecordCard>
  );
}
