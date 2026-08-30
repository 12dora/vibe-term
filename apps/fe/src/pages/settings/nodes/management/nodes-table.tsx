// 节点表：成员集 + 心跳合并后的一行一 node，重命名 / 吊销动作。
// hub 不可达时全部管理动作禁用。
// 表格本体铺在「节点管理」卡片里，只留一层浅边框做横向滚动容器。

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import type { NodeRow } from '@/node/mesh-nodes';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Pencil, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NodeActionDeps } from './types';
import { useNodeRowActions } from './use-node-row-actions';

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
        </div>
      </Td>
    </tr>
  );
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
