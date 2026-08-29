// 节点表：成员集 + 心跳合并后的一行一 node，重命名 / 吊销动作。
// hub 不可达时全部管理动作禁用。
// 表格本体铺在「节点管理」卡片里，只留一层浅边框做横向滚动容器。

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { headFromResponse } from '@/auth/key-log-actions';
import { buildRevokeNodeRecord, classifyKeyLogFailure } from '@/node/enrollment';
import type { HubApi } from '@/node/hub-api';
import type { NodeRow } from '@/node/mesh-nodes';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import { encodeBase64url } from '@tmex/shared/auth';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Pencil, ShieldAlert } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ResolvedMode } from './types';

export function NodesTable({
  rows,
  hubApi,
  hubOnline,
  mode,
  api,
  prompt,
  onChanged,
}: {
  rows: NodeRow[];
  hubApi: HubApi | null;
  hubOnline: boolean;
  mode: ResolvedMode;
  api: AuthApi;
  prompt: CredentialPromptHandle;
  onChanged: () => void;
}) {
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
            <NodeRowView
              key={row.id}
              row={row}
              hubApi={hubApi}
              hubOnline={hubOnline}
              mode={mode}
              api={api}
              prompt={prompt}
              onChanged={onChanged}
            />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                {t('nodes.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="whitespace-nowrap px-3 py-2 text-left font-medium">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="whitespace-nowrap px-3 py-2 align-middle">{children}</td>;
}

export function formatLastSeen(value: number | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function NodeRowView({
  row,
  hubApi,
  hubOnline,
  mode,
  api,
  prompt,
  onChanged,
}: {
  row: NodeRow;
  hubApi: HubApi | null;
  hubOnline: boolean;
  mode: ResolvedMode;
  api: AuthApi;
  prompt: CredentialPromptHandle;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(row.name);
  const [busy, setBusy] = useState(false);

  const rename = useCallback(async () => {
    if (!hubApi) return;
    setBusy(true);
    try {
      await hubApi.rename(row.id, nameDraft);
      setRenaming(false);
      toast.success(t('nodes.rename.done'));
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [hubApi, nameDraft, onChanged, row.id, t]);

  /**
   * 吊销：**只有一条路径**——`POST /api/auth/keylog?hub=sync`。
   * entry 先把签好的记录送 hub 等 ack，再本地 append。
   * 老实现「本地 append + 再调 hub revoke」是两条独立通道，先到的那条会让另一条报 `seq_gap`，
   * UI 误报 hub 失败；两条都失败时本地却已经把节点从列表里摘掉（见 F4-3 评审 Major）。
   *
   * 凭据走 `withSigner`（**不**进 5 分钟复用窗口）：吊销是破坏性动作，每次都要用户当场确认；
   * 根钥路径签完立刻清零 seed。
   */
  const revoke = useCallback(async () => {
    const confirmed = globalThis.confirm?.(t('nodes.revoke.confirmText', { name: row.name }));
    if (!confirmed) return;
    const reason = globalThis.prompt?.(t('nodes.revoke.reasonPrompt')) ?? '';
    setBusy(true);
    try {
      const rootEpoch = requireRootEpoch(mode);
      const head = headFromResponse(await api.keyLogHead());
      const result = await prompt.withSigner(
        async (signer) => {
          const record = await buildRevokeNodeRecord({
            head,
            rootEpoch,
            uid: mode.uid,
            nodeIdHex: row.id,
            reason,
            signer,
          });
          return api.appendKeyLog(
            { bytes: encodeBase64url(record.bytes), sig: encodeBase64url(record.sig) },
            { hubSync: true }
          );
        },
        { purpose: 'revoke' }
      );
      if (!result) return;
      if (!result.ok) {
        // B2-6：hub 未确认时服务端一条都没落库（409 / 504），撤销**没有生效**——
        // 文案必须这么说，否则用户会以为节点已经吊销掉了。
        const failure = classifyKeyLogFailure(result.code);
        if (failure === 'unconfirmed') {
          toast.warning(t('nodes.revoke.hubFailed', { error: result.code }));
          return;
        }
        toast.error(
          failure === 'stale'
            ? t('nodes.enrollment.staleRecord')
            : t(`auth.errors.${result.code}`, { defaultValue: result.code })
        );
        return;
      }
      if (result.hubAck !== true) {
        toast.warning(t('nodes.revoke.hubFailed', { error: result.hubError ?? '' }));
        return;
      }
      toast.success(t('nodes.revoke.done'));
      onChanged();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      toast.error(
        code
          ? t(`auth.errors.${code}`, { defaultValue: code })
          : err instanceof Error
            ? err.message
            : String(err)
      );
    } finally {
      setBusy(false);
    }
  }, [api, mode, onChanged, prompt, row.id, row.name, t]);

  const disabledHint = hubOnline ? undefined : t('nodes.hubOffline');

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
        <span
          data-testid={`nodes-status-${row.id}`}
          className={row.online ? 'text-emerald-500' : 'text-muted-foreground'}
        >
          {row.online ? t('nodes.status.online') : t('nodes.status.offline')}
        </span>
      </Td>
      <Td>
        <span data-testid={`nodes-reach-${row.id}`}>
          {row.reach === 'lan'
            ? t('nodes.reach.lan')
            : row.reach === 'relay'
              ? t('nodes.reach.relay')
              : '—'}
        </span>
      </Td>
      <Td>{row.version ?? '—'}</Td>
      <Td>{formatLastSeen(row.lastSeenAt)}</Td>
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
            disabled={!hubOnline || busy}
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
            disabled={!hubOnline || busy || row.isSelf}
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

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}
