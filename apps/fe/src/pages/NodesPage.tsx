// Nodes 管理页 `/nodes`（设计 §4「Nodes 管理页」）。
//
// 列表 = `GET /api/mesh/nodes`（成员集权威）合并 `GET /n/<hub>/api/hub/nodes`（心跳 / 状态）。
// 动作：新增节点（enrollment）、重命名、吊销。hub 不可达时全部管理动作禁用。
//
// 安全约束（设计 §2）：
//   - `sk_sess` 不能签任何记录 → 每个动作当场要密码（根钥）或 passkey；
//   - `enroll_sk` 只存在于浏览器与 join 串里，**不经过 hub**；
//   - `admit-node` 只在 `certificate.enroll_pk` 命中本地 pending、`cert_sig` 验签通过、
//     且 pending 未过期时才签；不匹配的证书告警「收到未知节点证书」并忽略。

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import { rootSignerFromPassword } from '@/auth/account-security-actions';
import { type RecordSigner, headFromResponse } from '@/auth/key-log-actions';
import { deriveRootKey, kdfParamsFromJson } from '@/auth/key-log-actions';
import { useAuthMode } from '@/auth/use-session-key';
import {
  type PendingEnrollment,
  buildAdmitNodeRecord,
  buildRevokeNodeRecord,
  createEnrollmentOnHub,
  joinCommand,
  listPendingEnrollments,
  prunePendingEnrollments,
  rememberSigner,
  removePendingEnrollment,
  subscribePendingEnrollments,
  takeRememberedSigner,
} from '@/node/enrollment';
import {
  type CertificateOutcome,
  certificatesFromHubNodes,
  certificatesFromMeshNodes,
  offerCertificate,
  useEnrollmentWatch,
} from '@/node/enrollment-watch';
import type { HubApi } from '@/node/hub-api';
import {
  type NodeRow,
  mergeNodes,
  setEntryNodeId,
  useHubNode,
  useMeshNodes,
} from '@/node/mesh-nodes';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { encodeBase64url } from '@tmex/shared/auth';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import {
  Check,
  Copy,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';

export interface NodesPageProps {
  mode?: AuthModeResponse;
  api?: AuthApi;
}

export default function NodesPage({ mode: modeOverride, api = defaultAuthApi }: NodesPageProps) {
  const fetched = useAuthMode(api, { enabled: !modeOverride });
  const mode = modeOverride ?? fetched.mode;

  if (!modeOverride && fetched.loading) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }
  if (!mode || mode.mode === 'none') {
    return null;
  }
  return <NodesView mode={mode} api={api} />;
}

// ---------------------------------------------------------------------------
// 主视图
// ---------------------------------------------------------------------------

type ResolvedMode = AuthModeResponse & { uid: string; kdfParams: AuthKdfParamsJson };

function NodesView({ mode: rawMode, api }: { mode: AuthModeResponse; api: AuthApi }) {
  const { t } = useTranslation();
  const { nodes, refresh: refreshNodes } = useMeshNodes();
  const entryNodeId = rawMode.nodeId || null;

  useEffect(() => {
    setEntryNodeId(entryNodeId);
  }, [entryNodeId]);

  const hub = useHubNode(nodes, entryNodeId);
  const rows = useMemo(
    () => mergeNodes(nodes, hub.hubNodes, { entryNodeId, hubNodeId: hub.hubNodeId }),
    [nodes, hub.hubNodes, hub.hubNodeId, entryNodeId]
  );

  const pendings = useSyncExternalStore(
    subscribePendingEnrollments,
    listPendingEnrollments,
    listPendingEnrollments
  );

  const hasCredentials = Boolean(rawMode.uid && rawMode.kdfParams);
  const mode: ResolvedMode | null = hasCredentials
    ? { ...rawMode, uid: rawMode.uid as string, kdfParams: rawMode.kdfParams as AuthKdfParamsJson }
    : null;

  const refreshAll = useCallback(() => {
    refreshNodes();
    hub.refresh();
  }, [hub, refreshNodes]);

  const admit = useAdmitAction({ api, mode, hubApi: hub.hubApi, onDone: refreshAll });

  // 后端补上 `enroll.redeemed` 推送前，pending 存在期间轮询证书。
  useEnrollmentWatch({
    pendings,
    hubApi: hub.hubApi,
    onOutcome: (outcome) => void admit.handleOutcome(outcome),
  });

  useEffect(() => {
    prunePendingEnrollments(Date.now());
  }, []);

  if (!mode) {
    return (
      <div className="mx-auto w-full max-w-5xl p-5 text-sm text-muted-foreground">
        {t('auth.errors.UNKNOWN_USER')}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-3 sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-sm font-semibold">{t('nodes.title')}</h1>
          <p className="text-xs text-muted-foreground">{t('nodes.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refreshAll}
            data-testid="nodes-refresh"
          >
            <RefreshCw />
            {t('nodes.actions.refresh')}
          </Button>
          <Link
            to="/account/security"
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            data-testid="nodes-account-security"
          >
            {t('nodes.actions.accountSecurity')}
          </Link>
        </div>
      </header>

      {!hub.online && (
        <p
          className="flex items-center gap-1.5 rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
          data-testid="nodes-hub-offline"
        >
          <ShieldAlert className="size-3.5 shrink-0" />
          {t('nodes.hubOffline')}
        </p>
      )}

      <EnrollmentSection
        api={api}
        mode={mode}
        hubApi={hub.hubApi}
        hubOnline={hub.online}
        pendings={pendings}
        onConfirm={(pending) => void admit.confirmManually(pending)}
        busyPendingId={admit.busyPendingId}
      />

      <NodesTable
        rows={rows}
        hubApi={hub.hubApi}
        hubOnline={hub.online}
        mode={mode}
        api={api}
        onChanged={refreshAll}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// admit 动作（自动 / 手动共用同一条路径）
// ---------------------------------------------------------------------------

function useAdmitAction({
  api,
  mode,
  hubApi,
  onDone,
}: {
  api: AuthApi;
  mode: ResolvedMode | null;
  hubApi: HubApi | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [busyPendingId, setBusyPendingId] = useState<string | null>(null);

  const signAdmit = useCallback(
    async (
      pending: PendingEnrollment,
      certificateBytes: Uint8Array,
      certSig: Uint8Array,
      signer: RecordSigner
    ) => {
      if (!mode) return;
      const head = headFromResponse(await api.keyLogHead());
      const record = await buildAdmitNodeRecord({
        head,
        rootEpoch: mode.rootEpoch ?? 0,
        uid: mode.uid,
        pending,
        certificateBytes,
        certSig,
        signer,
      });
      const result = await api.appendKeyLog({
        bytes: encodeBase64url(record.bytes),
        sig: encodeBase64url(record.sig),
      });
      if (!result.ok) {
        toast.error(t(`auth.errors.${result.code}`, { defaultValue: result.code }));
        return;
      }
      removePendingEnrollment(pending.id);
      toast.success(t('nodes.enrollment.admitted'));
      onDone();
    },
    [api, mode, onDone, t]
  );

  /** 轮询 / 推送检测出的结果。已过期或签名坏的直接告警；能自动签就自动签。 */
  const handleOutcome = useCallback(
    async (outcome: CertificateOutcome) => {
      if (outcome.kind === 'unknown') {
        toast.error(t('nodes.enrollment.unknownCertificate'));
        return;
      }
      if (outcome.kind === 'invalid') {
        toast.error(
          outcome.reason === 'expired'
            ? t('nodes.enrollment.expired')
            : t('nodes.enrollment.badCertSig')
        );
        return;
      }
      const signer = takeRememberedSigner(Date.now());
      if (!signer) {
        // 凭据复用窗口已过：留在「待确认」，等用户点确认按钮重新输入密码。
        return;
      }
      setBusyPendingId(outcome.pending.id);
      try {
        await signAdmit(outcome.pending, outcome.certificateBytes, outcome.certSig, signer);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyPendingId(null);
      }
    },
    [signAdmit, t]
  );

  /** 「待确认」按钮：重新要密码，然后立刻做一轮证书检测。 */
  const confirmManually = useCallback(
    async (pending: PendingEnrollment) => {
      if (!mode) return;
      const password = globalThis.prompt?.(t('nodes.enrollment.passwordPrompt')) ?? '';
      if (!password) return;
      setBusyPendingId(pending.id);
      try {
        const signer = await rootSignerFromPassword(password, mode.kdfParams);
        rememberSigner(signer, Date.now());
        const [hubRows, meshNodes] = await Promise.all([
          hubApi ? hubApi.listNodes().catch(() => []) : Promise.resolve([]),
          api.listNodes().catch(() => []),
        ]);
        const candidates = [
          ...certificatesFromHubNodes(hubRows),
          ...certificatesFromMeshNodes(meshNodes),
        ];
        for (const candidate of candidates) {
          const outcome = offerCertificate([pending], candidate, Date.now());
          if (outcome.kind === 'admit') {
            await signAdmit(pending, outcome.certificateBytes, outcome.certSig, signer);
            return;
          }
          if (outcome.kind === 'invalid') {
            toast.error(
              outcome.reason === 'expired'
                ? t('nodes.enrollment.expired')
                : t('nodes.enrollment.badCertSig')
            );
            return;
          }
        }
        toast.error(t('nodes.enrollment.noCertificateYet'));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyPendingId(null);
      }
    },
    [api, hubApi, mode, signAdmit, t]
  );

  return { handleOutcome, confirmManually, busyPendingId };
}

// ---------------------------------------------------------------------------
// 新增节点 / 待确认
// ---------------------------------------------------------------------------

function EnrollmentSection({
  api,
  mode,
  hubApi,
  hubOnline,
  pendings,
  onConfirm,
  busyPendingId,
}: {
  api: AuthApi;
  mode: ResolvedMode;
  hubApi: HubApi | null;
  hubOnline: boolean;
  pendings: PendingEnrollment[];
  onConfirm: (pending: PendingEnrollment) => void;
  busyPendingId: string | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<PendingEnrollment | null>(null);

  const hubUrl = hubPublicUrl();

  const submit = useCallback(async () => {
    setError(null);
    if (!hubApi) {
      setError(t('nodes.hubOffline'));
      return;
    }
    if (!password) {
      setError(t('auth.security.passwordRequired'));
      return;
    }
    setBusy(true);
    try {
      const head = await api.keyLogHead();
      const rootKey = await deriveRootKey(password, kdfParamsFromJson(mode.kdfParams));
      setPassword('');
      const pending = await createEnrollmentOnHub({
        hubApi,
        uid: mode.uid,
        rootEpoch: mode.rootEpoch ?? 0,
        rootKey,
        keyLogHeadHash: headFromResponse(head).hash,
        name,
      });
      // 设计 §2 步骤 3：enroll 那次交互后 5 分钟内自动签 admit-node，不再要一次密码。
      rememberSigner({ kind: 'root', rootKey }, Date.now());
      setCreated(pending);
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [api, hubApi, mode.kdfParams, mode.rootEpoch, mode.uid, name, password, t]);

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('nodes.enrollment.title')}</h2>
        <Button
          type="button"
          size="sm"
          disabled={!hubOnline}
          title={hubOnline ? undefined : t('nodes.hubOffline')}
          onClick={() => setOpen((value) => !value)}
          data-testid="nodes-add"
        >
          <Plus />
          {t('nodes.actions.addNode')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('nodes.enrollment.description')}</p>

      {open && (
        <div className="flex flex-col gap-2" data-testid="nodes-enroll-form">
          <Input
            placeholder={t('nodes.enrollment.nameLabel')}
            value={name}
            data-testid="nodes-enroll-name"
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            type="password"
            autoComplete="current-password"
            placeholder={t('auth.security.currentPassword')}
            value={password}
            data-testid="nodes-enroll-password"
            onChange={(event) => setPassword(event.target.value)}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div>
            <Button
              type="button"
              disabled={busy || !hubOnline}
              onClick={() => void submit()}
              data-testid="nodes-enroll-submit"
            >
              {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              {t('nodes.enrollment.create')}
            </Button>
          </div>
        </div>
      )}

      {created && (
        <div
          className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2"
          data-testid="nodes-join-info"
        >
          <p className="text-xs text-muted-foreground">{t('nodes.enrollment.joinHint')}</p>
          <CopyableCode
            label={t('nodes.enrollment.joinCommand')}
            value={joinCommand(hubUrl, created.joinToken, created.name)}
            testId="nodes-join-command"
          />
          <CopyableCode
            label={t('nodes.enrollment.joinToken')}
            value={created.joinToken}
            testId="nodes-join-token"
          />
        </div>
      )}

      {pendings.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="nodes-pending-list">
          {pendings.map((pending) => (
            <li
              key={pending.id}
              className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-2 py-1.5 text-xs"
              data-testid={`nodes-pending-${pending.id}`}
            >
              <span className="truncate">
                {t('nodes.enrollment.pending')}
                <span className="ml-2 font-mono text-muted-foreground">
                  {pending.name ?? pending.enrollPk.slice(0, 12)}
                </span>
              </span>
              <Button
                type="button"
                size="xs"
                disabled={busyPendingId === pending.id}
                onClick={() => onConfirm(pending)}
                data-testid={`nodes-pending-confirm-${pending.id}`}
              >
                {busyPendingId === pending.id ? <Loader2 className="animate-spin" /> : <Check />}
                {t('nodes.enrollment.confirmPending')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * join 命令里的 hub 地址。后端目前没有把 hub 的 `config.publicUrl` 下发给浏览器
 * （见结果文档「后端待补」），退化成当前页面 origin——hub,node 同机时它就是对的。
 */
export function hubPublicUrl(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  return origin ?? 'https://<hub-public-url>';
}

function CopyableCode({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="flex items-start gap-1">
        <code
          className="min-w-0 flex-1 break-all rounded bg-background p-2 text-[11px]"
          data-testid={testId}
        >
          {value}
        </code>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={copy}
          data-testid={`${testId}-copy`}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? t('nodes.actions.copied') : t('nodes.actions.copy')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 节点表
// ---------------------------------------------------------------------------

function NodesTable({
  rows,
  hubApi,
  hubOnline,
  mode,
  api,
  onChanged,
}: {
  rows: NodeRow[];
  hubApi: HubApi | null;
  hubOnline: boolean;
  mode: ResolvedMode;
  api: AuthApi;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="overflow-x-auto rounded-xl border border-border bg-background">
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
  onChanged,
}: {
  row: NodeRow;
  hubApi: HubApi | null;
  hubOnline: boolean;
  mode: ResolvedMode;
  api: AuthApi;
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

  const revoke = useCallback(async () => {
    if (!hubApi) return;
    const confirmed = globalThis.confirm?.(t('nodes.revoke.confirmText', { name: row.name }));
    if (!confirmed) return;
    const password = globalThis.prompt?.(t('nodes.enrollment.passwordPrompt')) ?? '';
    if (!password) return;
    const reason = globalThis.prompt?.(t('nodes.revoke.reasonPrompt')) ?? '';
    setBusy(true);
    try {
      const signer = await rootSignerFromPassword(password, mode.kdfParams);
      const head = headFromResponse(await api.keyLogHead());
      const record = await buildRevokeNodeRecord({
        head,
        rootEpoch: mode.rootEpoch ?? 0,
        uid: mode.uid,
        nodeIdHex: row.id,
        reason,
        signer,
      });
      const body = { bytes: encodeBase64url(record.bytes), sig: encodeBase64url(record.sig) };
      const appended = await api.appendKeyLog(body);
      // hub 也要拿到同一条记录（它据此断开 uplink 并置 nodes.status=revoked）。
      // 两侧是同一条 `{bytes, sig}`，重复 append 不构成分叉；hub 侧失败只降级为告警。
      let hubError: string | null = null;
      try {
        await hubApi.revoke(row.id, body);
      } catch (err) {
        hubError = err instanceof Error ? err.message : String(err);
      }
      if (!appended.ok) {
        toast.error(t(`auth.errors.${appended.code}`, { defaultValue: appended.code }));
        return;
      }
      if (hubError) toast.warning(t('nodes.revoke.hubFailed', { error: hubError }));
      else toast.success(t('nodes.revoke.done'));
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [api, hubApi, mode.kdfParams, mode.rootEpoch, mode.uid, onChanged, row.id, row.name, t]);

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

export const PageTitle = () => {
  const { t } = useTranslation();
  return <>{t('nodes.title')}</>;
};

/** 供路由表挂载。 */
export const nodesRoute = {
  path: '/nodes',
  moduleLoader: () => import('./NodesPage'),
} as const;
