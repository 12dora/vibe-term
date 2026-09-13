// 节点表在 sm 以下的版式：一台节点一张记录卡。
//
// 表里那八列（勾选 / 名称 / 状态 / 连接方式 / 版本 / 地址 / 支持直连 / 操作）在 390px 下只能靠
// 横滚看完，动作列更是整列被裁掉。卡片把它们摊成：标题行（勾选 + 名称 + 标记 + ⋯）、
// 两条弱化信息行（状态 · 连接方式 · 版本 · 直连；地址 + 复制）、末行动作（升级 / 停止 / 吊销）。
// 状态与动作全部取自 `useNodeRowShared`，与宽表同一份；testid 也逐个对齐，两套版式对测试等价。

import {
  RecordCard,
  RecordCardEmpty,
  RecordCardList,
  RecordCardMeta,
} from '@/components/record-card';
import type { NodeRow } from '@/node/mesh-nodes';
import { Checkbox } from '@vibeterm/ui/checkbox';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { CopyButton } from '../copy-feedback';
import { resolveNodePorts } from '../port-reach';
import { NodeMoreMenu } from './node-more-menu';
import { NodeNameTags, StatusCell } from './node-row-cells';
import {
  NodeRowDialogs,
  type NodesTableProps,
  RevokeButton,
  SelectAllButton,
  UpgradeButton,
  UpgradeCancelButton,
  useNodeRowShared,
} from './node-row-common';
import { PendingNodeCard } from './pending-node-row';
import { PortsWarning, displayAddress } from './row-cells';
import type { NodeActionDeps, NodeSelection, NodeUninstallController } from './types';
import type { HubRoleSwitchController } from './use-hub-role-switch';
import { isUpgradeBusy } from './use-node-upgrade';

/** 缺省值：连接方式 / 版本 / 地址拿不到时 `buildNodeView` 给的就是它。 */
const DASH = '—';

export function NodesCardList({
  rows,
  selection,
  uninstall,
  roleSwitch,
  ...deps
}: NodesTableProps) {
  const { t } = useTranslation();
  const pathname = useLocation().pathname;
  const selected = selection.ids.size;
  return (
    <div className="flex flex-col gap-2" data-testid="nodes-table">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <SelectAllButton selection={selection} />
        <span data-testid="nodes-selection-count">
          {selected > 0
            ? t('nodes.table.mobile.selected', { count: selected })
            : t('nodes.selection.selectAll')}
        </span>
      </div>
      <RecordCardList>
        {rows.map((row) =>
          row.pending ? (
            <PendingNodeCard key={row.id} row={row} {...deps} />
          ) : (
            <NodeCardView
              key={row.id}
              row={row}
              pathname={pathname}
              selection={selection}
              uninstall={uninstall}
              roleSwitch={roleSwitch}
              {...deps}
            />
          )
        )}
        {rows.length === 0 && <RecordCardEmpty>{t('nodes.empty')}</RecordCardEmpty>}
      </RecordCardList>
    </div>
  );
}

function NodeCardView({
  row,
  pathname,
  selection,
  uninstall,
  roleSwitch,
  ...deps
}: {
  row: NodeRow;
  pathname: string;
  selection: NodeSelection;
  uninstall: NodeUninstallController;
  roleSwitch: HubRoleSwitchController;
} & NodeActionDeps) {
  const { t } = useTranslation();
  const shared = useNodeRowShared(row, deps, uninstall, roleSwitch);
  const { view } = shared;

  return (
    <RecordCard testId={`nodes-row-${row.id}`}>
      <div className="flex items-start gap-2">
        <Checkbox
          className="mt-0.5"
          checked={selection.ids.has(row.id)}
          disabled={!shared.selectable}
          aria-label={row.name}
          title={row.isSelf ? t('nodes.selection.selfBlocked') : undefined}
          onCheckedChange={() => selection.toggle(row.id)}
          data-testid={`nodes-select-${row.id}`}
        />
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <NodeNameTags
            row={row}
            hubDetails={deps.hubDetails}
            roleSwitch={roleSwitch}
            rowBusy={shared.uninstalling || isUpgradeBusy(deps.upgrade.entryOf(row.id).phase)}
          />
        </span>
        {/* 详情里既有只读信息也有节点本地的域名访问策略，hub 不可写时照样能开。 */}
        <NodeMoreMenu
          row={row}
          pathname={pathname}
          onChanged={deps.onChanged}
          onDetail={() => shared.setDetailOpen(true)}
        />
      </div>

      <RecordCardMeta>
        <StatusCell
          row={row}
          uninstall={uninstall}
          uninstalling={shared.uninstalling}
          switching={shared.switching}
          view={view}
        />
        {view.reachText !== DASH && (
          <span data-testid={`nodes-reach-${row.id}`}>{view.reachText}</span>
        )}
        {row.version && <span>{row.version}</span>}
        <span>
          {t(row.directCapable ? 'nodes.table.mobile.direct' : 'nodes.table.mobile.noDirect')}
        </span>
      </RecordCardMeta>

      <NodeCardAddress row={row} />

      <div className="flex flex-wrap items-center gap-1">
        <UpgradeButton row={row} upgrade={deps.upgrade} blocked={shared.uninstalling} />
        <UpgradeCancelButton row={row} upgrade={deps.upgrade} />
        <RevokeButton row={row} shared={shared} />
      </div>

      <NodeRowDialogs row={row} shared={shared} deps={deps} />
    </RecordCard>
  );
}

/**
 * 地址那一行：截断 + 悬浮全文 + 复制，后面接端口不可达的警告。
 * 没有地址（本机那一行、待批准的机器）就整行不出——一个「—」既读不出信息，还多占一行。
 */
function NodeCardAddress({ row }: { row: NodeRow }) {
  const address = displayAddress(row.address);
  return (
    <>
      {address && (
        <div className="flex items-center gap-1">
          <code
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
            title={address}
            data-testid={`nodes-address-${row.id}`}
          >
            {address}
          </code>
          <CopyButton value={address} testId={`nodes-address-${row.id}`} />
        </div>
      )}
      <PortsWarning nodeId={row.id} ports={resolveNodePorts(row)} />
    </>
  );
}
