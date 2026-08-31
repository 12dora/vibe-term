// 节点表：成员集 + 心跳合并后的一行一 node，重命名 / 吊销 / 升级动作。
// hub 不可达时重命名与吊销禁用——它们走 hub 控制面；升级只依赖入口 → 目标的 peer link，
// 因此**不**跟 hub 在线绑定，只看目标是否在线、是否已登录。
// 表格本体铺在「节点管理」卡片里，只留一层浅边框做横向滚动容器。

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import type { NodeRow } from '@/node/mesh-nodes';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Download, Loader2, Pencil, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NodeActionDeps } from './types';
import { useNodeRowActions } from './use-node-row-actions';
import { isUpgradeBusy, upgradePhaseText } from './use-node-upgrade';

export function NodesTable({ rows, ...deps }: { rows: NodeRow[] } & NodeActionDeps) {
  const { t } = useTranslation();
  return (
    <section className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full min-w-[52rem] text-xs" data-testid="nodes-table">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <Th>{t('nodes.columns.name')}</Th>
            <Th>{t('nodes.columns.status')}</Th>
            <Th>{t('nodes.columns.reach')}</Th>
            <Th>{t('nodes.columns.version')}</Th>
            <Th>{t('nodes.columns.lastSeen')}</Th>
            <Th>{t('nodes.columns.direct')}</Th>
            <Th>{t('nodes.columns.login')}</Th>
            <Th>{t('nodes.columns.fingerprint')}</Th>
            <Th>{t('nodes.columns.actions')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <NodeRowView key={row.id} row={row} {...deps} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className="tmex-fade px-3 py-6 text-center text-muted-foreground">
                {t('nodes.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function deriveNodeRow(row: NodeRow, t: (key: string) => string) {
  return {
    statusClass: row.online ? 'text-emerald-500' : 'text-muted-foreground',
    statusText: t(row.online ? 'nodes.status.online' : 'nodes.status.offline'),
    reachText: row.reach ? t(`nodes.reach.${row.reach}`) : '—',
  };
}

function NodeRowView({ row, ...deps }: { row: NodeRow } & NodeActionDeps) {
  const { t } = useTranslation();
  const { renaming, setRenaming, nameDraft, setNameDraft, busy, rename, revoke } =
    useNodeRowActions(row, deps);
  const disabledHint = deps.hubOnline ? undefined : t('nodes.hubOffline');
  const view = deriveNodeRow(row, t);

  return (
    <tr className="border-b border-border/60 last:border-0" data-testid={`nodes-row-${row.id}`}>
      <Td>
        {renaming ? (
          <div className="flex items-center gap-1">
            <Input
              value={nameDraft}
              className="h-7 w-32"
              data-testid={`nodes-rename-input-${row.id}`}
              onChange={(event) => setNameDraft(event.target.value)}
            />
            <Button type="button" size="xs" disabled={busy} onClick={() => void rename()}>
              {t('nodes.rename.save')}
            </Button>
          </div>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium">{row.name}</span>
            {row.isSelf && <Tag>{t('nodes.self')}</Tag>}
            {row.isHub && <Tag>{t('nodes.hub')}</Tag>}
          </span>
        )}
      </Td>
      <Td>
        <span data-testid={`nodes-status-${row.id}`} className={view.statusClass}>
          {view.statusText}
        </span>
      </Td>
      <Td>
        <span data-testid={`nodes-reach-${row.id}`}>{view.reachText}</span>
      </Td>
      <Td>{row.version ?? '—'}</Td>
      <Td>{row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : '—'}</Td>
      <Td>{row.directCapable ? t('common.yes') : t('common.no')}</Td>
      <Td>
        {row.loggedIn || row.isSelf ? (
          <span className="text-emerald-500">{t('nodes.loggedIn')}</span>
        ) : (
          <NodeLoginButton nodeId={row.runtimeNodeId} nodeName={row.name} />
        )}
      </Td>
      <Td>
        <code className="font-mono text-[11px] text-muted-foreground">{row.fingerprint}</code>
      </Td>
      <Td>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!deps.hubOnline || busy}
            title={disabledHint}
            onClick={() => setRenaming((value) => !value)}
            data-testid={`nodes-rename-${row.id}`}
          >
            <Pencil />
            {t('nodes.actions.rename')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={!deps.hubOnline || busy || row.isSelf}
            title={row.isSelf ? t('nodes.revoke.selfBlocked') : disabledHint}
            onClick={() => void revoke()}
            data-testid={`nodes-revoke-${row.id}`}
          >
            <ShieldAlert />
            {t('nodes.actions.revoke')}
          </Button>
          <UpgradeButton row={row} upgrade={deps.upgrade} />
        </div>
      </Td>
    </tr>
  );
}

/**
 * 升级按钮：目标离线或（远端）未登录时禁用并说明原因；进行中显示阶段文案并锁住。
 * 本机同样可以升级——它会重启本机网关，当前访问随之中断，确认框里已经写明。
 */
function UpgradeButton({ row, upgrade }: { row: NodeRow; upgrade: NodeActionDeps['upgrade'] }) {
  const { t } = useTranslation();
  const entry = upgrade.entryOf(row.id);
  const busy = isUpgradeBusy(entry.phase);
  const blocked = upgradeBlockedHint(row, t);
  const version = entry.targetVersion ?? upgrade.latest?.latestVersion ?? null;
  const phaseText = upgradePhaseText(t, entry.phase);

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={busy || blocked !== null}
      title={blocked ?? upgradeTitle(entry.error, version, t)}
      onClick={() => upgrade.start(row)}
      data-testid={`node-upgrade-${row.id}`}
      data-upgrade-phase={entry.phase}
    >
      {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Download />}
      {phaseText ?? t('nodes.upgrade.action')}
    </Button>
  );
}

function upgradeBlockedHint(row: NodeRow, t: (key: string) => string): string | null {
  if (!row.online) return t('nodes.upgrade.offline');
  if (!row.isSelf && !row.loggedIn) return t('nodes.upgrade.loginRequired');
  return null;
}

function upgradeTitle(
  error: string | null,
  version: string | null,
  t: (key: string, options?: Record<string, unknown>) => string
): string | undefined {
  if (error) return error;
  return version ? t('nodes.upgrade.hint', { version }) : undefined;
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="whitespace-nowrap px-3 py-2 text-left font-medium">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="whitespace-nowrap px-3 py-2 align-middle">{children}</td>;
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}
