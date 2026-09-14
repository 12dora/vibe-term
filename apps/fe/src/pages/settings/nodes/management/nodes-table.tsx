// 节点表：成员集合并后的一行一 node，升级 / 更多（详情、暂停）/ 吊销。
// 重命名与「允许域名访问」都收进详情框（「更多」），表里不再有行内输入框。
// 未挂中继时详情里的改名与吊销禁用——它们走 key-log；升级只依赖入口 → 目标的 peer link，
// 因此**不**跟上联可写绑定，只看目标是否在线、是否已登录。
// 表格本体铺在「节点管理」卡片里，横向滚动壳与「操作」列的钉边都在 components/wide-table。
// sm 以下八列摆不下，整表换成记录卡（nodes-card-list）：两套版式共用同一批 testid 与同一份状态。

import { useNarrowLayout } from '@/components/use-narrow-layout';
import type { NodeRow } from '@/node/mesh-nodes';
import { Checkbox } from '@vibeterm/ui/checkbox';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { WideTableScroll, stickyActionColumn } from '../../components/wide-table';
import { NodeMoreMenu } from './node-more-menu';
import { NameCell, StatusCell } from './node-row-cells';
import {
  NodeRowDialogs,
  type NodesTableProps,
  RevokeButton,
  SelectAllButton,
  UpgradeButton,
  UpgradeCancelButton,
  useNodeRowShared,
} from './node-row-common';
import { NodesCardList } from './nodes-card-list';
import { PendingNodeRow } from './pending-node-row';
import { Td, Th } from './row-cells';
import type { NodeActionDeps, NodeSelection, NodeUninstallController } from './types';
import { isUpgradeBusy } from './use-node-upgrade';

export type { NodesTableProps };

export function NodesTable(props: NodesTableProps) {
  const narrow = useNarrowLayout();
  if (narrow) return <NodesCardList {...props} />;
  return <NodesWideTable {...props} />;
}

function NodesWideTable({ rows, selection, uninstall, ...deps }: NodesTableProps) {
  const { t } = useTranslation();
  const pathname = useLocation().pathname;
  return (
    <WideTableScroll>
      <table className="w-full min-w-[48rem] text-xs" data-testid="nodes-table">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="w-8 px-2 py-2 text-left font-medium">
              <SelectAllButton selection={selection} />
            </th>
            <Th>{t('nodes.columns.name')}</Th>
            <Th>{t('nodes.columns.status')}</Th>
            <Th>{t('nodes.columns.reach')}</Th>
            <Th>{t('nodes.columns.version')}</Th>
            <Th>{t('nodes.columns.address')}</Th>
            <Th>{t('nodes.columns.direct')}</Th>
            <Th className={stickyActionColumn}>{t('nodes.columns.actions')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) =>
            row.pending ? (
              <PendingNodeRow key={row.id} row={row} {...deps} />
            ) : (
              <NodeRowView
                key={row.id}
                row={row}
                pathname={pathname}
                selection={selection}
                uninstall={uninstall}
                {...deps}
              />
            )
          )}
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} className="vibeterm-fade px-3 py-6 text-center text-muted-foreground">
                {t('nodes.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </WideTableScroll>
  );
}

function NodeRowView({
  row,
  pathname,
  selection,
  uninstall,
  ...deps
}: {
  row: NodeRow;
  pathname: string;
  selection: NodeSelection;
  uninstall: NodeUninstallController;
} & NodeActionDeps) {
  const { t } = useTranslation();
  const shared = useNodeRowShared(row, deps, uninstall);
  const { view } = shared;

  return (
    <tr className="border-b border-border/60 last:border-0" data-testid={`nodes-row-${row.id}`}>
      <td className="px-2 py-2 align-middle">
        <Checkbox
          checked={selection.ids.has(row.id)}
          disabled={!shared.selectable}
          aria-label={row.name}
          title={row.isSelf ? t('nodes.selection.selfBlocked') : undefined}
          onCheckedChange={() => selection.toggle(row.id)}
          data-testid={`nodes-select-${row.id}`}
        />
      </td>
      <NameCell
        row={row}
        rowBusy={shared.uninstalling || isUpgradeBusy(deps.upgrade.entryOf(row.id).phase)}
      />
      <Td>
        <StatusCell
          row={row}
          uninstall={uninstall}
          uninstalling={shared.uninstalling}
          view={view}
        />
      </Td>
      <Td>
        <span data-testid={`nodes-reach-${row.id}`}>{view.reachText}</span>
      </Td>
      <Td>{row.version ?? '—'}</Td>
      <Td>
        <code
          className="block max-w-[14rem] truncate font-mono text-[11px] text-muted-foreground"
          title={view.addressText}
          data-testid={`nodes-address-${row.id}`}
        >
          {view.addressText}
        </code>
      </Td>
      <Td>{row.directCapable ? t('common.yes') : t('common.no')}</Td>
      <Td className={stickyActionColumn}>
        <div className="flex items-center gap-1">
          <UpgradeButton row={row} upgrade={deps.upgrade} blocked={shared.uninstalling} />
          <UpgradeCancelButton row={row} upgrade={deps.upgrade} />
          {/* 详情里既有只读信息也有节点本地的域名访问策略，上联不可写时照样能开。 */}
          <NodeMoreMenu
            row={row}
            pathname={pathname}
            onChanged={deps.onChanged}
            onDetail={() => shared.setDetailOpen(true)}
          />
          <RevokeButton row={row} shared={shared} />
        </div>
        <NodeRowDialogs row={row} shared={shared} deps={deps} />
      </Td>
    </tr>
  );
}
