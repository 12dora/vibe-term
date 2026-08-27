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
import { rootSignerFromPassword, withRootSigner } from '@/auth/account-security-actions';
import { type RecordSigner, headFromResponse } from '@/auth/key-log-actions';
import { deriveRootKey, kdfParamsFromJson } from '@/auth/key-log-actions';
import { useAuthMode } from '@/auth/use-session-key';
import {
  type CreatedEnrollment,
  type PendingEnrollment,
  buildAdmitNodeRecord,
  buildRevokeNodeRecord,
  createEnrollmentOnHub,
  forgetSigner,
  isPendingExpired,
  joinCommand,
  listPendingEnrollments,
  nextPendingExpiry,
  prunePendingEnrollments,
  rememberSigner,
  removePendingEnrollment,
  subscribePendingEnrollments,
  takeRememberedSigner,
} from '@/node/enrollment';
import {
  type CertificateOutcome,
  collectRedeemedCertificates,
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
import { defaultAuthApi, requireRootEpoch } from '@tmex/api-client/auth/index';
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

  const hub = useHubNode(nodes, { hubNodeId: rawMode.hubNodeId ?? null });
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

  const [expiredIds, setExpiredIds] = useState<string[]>([]);
  const admit = useAdmitAction({ api, mode, hubApi: hub.hubApi, onDone: refreshAll });

  useEnrollmentWatch({
    pendings,
    hubApi: hub.hubApi,
    onOutcome: (outcome) => void admit.handleOutcome(outcome),
  });

  // 过期清理必须是**定时**的：页面一直开着时，十分钟前建的 pending 不能继续留在
  // 内存与 sessionStorage 里，对应的 join 串也不能继续留在 DOM（见 F4-3 评审 Major）。
  useEffect(() => {
    const sweep = () => {
      const removed = prunePendingEnrollments(Date.now());
      if (removed.length > 0) setExpiredIds(removed.map((row) => row.hubEnrollmentId));
    };
    sweep();
    const next = nextPendingExpiry(pendings);
    if (next === null) return;
    const timer = setTimeout(sweep, Math.max(0, next - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [pendings]);

  // 离开页面即丢弃 5 分钟凭据复用窗口里的根钥副本。
  useEffect(() => () => forgetSigner(), []);

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
        hubUnconfirmedIds={admit.hubUnconfirmedIds}
        clearedIds={[...expiredIds, ...admit.admittedIds]}
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
  /** hub 未确认的 pending：保留待确认状态并给出重试入口。 */
  const [hubUnconfirmedIds, setHubUnconfirmedIds] = useState<string[]>([]);
  /** 已 admit 掉的 pending（用于清掉页面上对应的 join 串）。 */
  const [admittedIds, setAdmittedIds] = useState<string[]>([]);

  const signAdmit = useCallback(
    async (
      pending: PendingEnrollment,
      certificateBytes: Uint8Array,
      certSig: Uint8Array,
      signer: RecordSigner
    ) => {
      if (!mode) return;
      const head = headFromResponse(await api.keyLogHead());
      // 取 head 是异步的：这中间 pending 可能已经过期，过期后签出来的 admit 也不该被接受。
      if (isPendingExpired(pending, Date.now())) {
        toast.error(t('nodes.enrollment.expired'));
        removePendingEnrollment(pending.hubEnrollmentId);
        setAdmittedIds((ids) => [...ids, pending.hubEnrollmentId]);
        return;
      }
      const record = await buildAdmitNodeRecord({
        head,
        rootEpoch: requireRootEpoch(mode),
        uid: mode.uid,
        pending,
        certificateBytes,
        certSig,
        signer,
      });
      // hub=sync：entry 先把记录送 hub 并等 ack 再本地 append。
      const result = await api.appendKeyLog(
        { bytes: encodeBase64url(record.bytes), sig: encodeBase64url(record.sig) },
        { hubSync: true }
      );
      if (!result.ok) {
        toast.error(t(`auth.errors.${result.code}`, { defaultValue: result.code }));
        return;
      }
      if (result.hubAck !== true) {
        // hub 没确认就删 pending 会把 enroll 授权丢掉，而新 node 永远成不了 mesh 成员。
        setHubUnconfirmedIds((ids) =>
          ids.includes(pending.hubEnrollmentId) ? ids : [...ids, pending.hubEnrollmentId]
        );
        toast.warning(t('nodes.enrollment.hubNotConfirmed'));
        return;
      }
      setHubUnconfirmedIds((ids) => ids.filter((id) => id !== pending.hubEnrollmentId));
      removePendingEnrollment(pending.hubEnrollmentId);
      setAdmittedIds((ids) => [...ids, pending.hubEnrollmentId]);
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
      setBusyPendingId(outcome.pending.hubEnrollmentId);
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

  /** 「待确认 / 重试」按钮：重新要密码，然后立刻向 hub 查一次本次 enrollment 的证书。 */
  const confirmManually = useCallback(
    async (pending: PendingEnrollment) => {
      if (!mode) return;
      const password = globalThis.prompt?.(t('nodes.enrollment.passwordPrompt')) ?? '';
      if (!password) return;
      setBusyPendingId(pending.hubEnrollmentId);
      try {
        const signer = await rootSignerFromPassword(password, mode.kdfParams);
        // 记住这次交互：后续自动 admit 复用它；离开页面 / 超时会清零。
        rememberSigner(signer, Date.now());
        const candidates = hubApi ? await collectRedeemedCertificates(hubApi, [pending]) : [];
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
    [hubApi, mode, signAdmit, t]
  );

  return { handleOutcome, confirmManually, busyPendingId, hubUnconfirmedIds, admittedIds };
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
  hubUnconfirmedIds,
  clearedIds,
}: {
  api: AuthApi;
  mode: ResolvedMode;
  hubApi: HubApi | null;
  hubOnline: boolean;
  pendings: PendingEnrollment[];
  onConfirm: (pending: PendingEnrollment) => void;
  busyPendingId: string | null;
  hubUnconfirmedIds: string[];
  /** 已 admit / 已过期的 pending id：对应的 join 串必须立刻从 DOM 里消失。 */
  clearedIds: string[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // join 串只在内存里、只显示这一次；admit / 过期后立即清掉。
  const [created, setCreated] = useState<CreatedEnrollment | null>(null);

  useEffect(() => {
    if (created && clearedIds.includes(created.pending.hubEnrollmentId)) setCreated(null);
  }, [clearedIds, created]);

  const hubUrl = resolveHubPublicUrl(created, mode);

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
      const rootEpoch = requireRootEpoch(mode);
      const head = await api.keyLogHead();
      const rootKey = await deriveRootKey(password, kdfParamsFromJson(mode.kdfParams));
      setPassword('');
      const outcome = await createEnrollmentOnHub({
        hubApi,
        uid: mode.uid,
        rootEpoch,
        rootKey,
        keyLogHeadHash: headFromResponse(head).hash,
        name,
      });
      // 设计 §2 步骤 3：enroll 那次交互后 5 分钟内自动签 admit-node，不再要一次密码。
      rememberSigner({ kind: 'root', rootKey }, Date.now());
      setCreated(outcome);
      setName('');
    } catch (err) {
      const code = (err as { code?: string })?.code;
      setError(
        code
          ? t(`auth.errors.${code}`, { defaultValue: code })
          : err instanceof Error
            ? err.message
            : String(err)
      );
    } finally {
      setBusy(false);
    }
  }, [api, hubApi, mode, name, password, t]);

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

      {created &&
        (hubUrl ? (
          <div
            className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2"
            data-testid="nodes-join-info"
          >
            <p className="text-xs text-muted-foreground">{t('nodes.enrollment.joinHint')}</p>
            <CopyableCode
              label={t('nodes.enrollment.joinCommand')}
              value={joinCommand(hubUrl, created.joinToken, created.pending.name)}
              testId="nodes-join-command"
            />
            <CopyableCode
              label={t('nodes.enrollment.joinToken')}
              value={created.joinToken}
              testId="nodes-join-token"
            />
          </div>
        ) : (
          // hub 没给出对外地址就不能编 join 命令：用入口 origin 会把新设备指到没有
          // HubRuntime 的机器，redeem 直接 404（见 F4-3 评审 Blocker）。
          <p className="text-xs text-destructive" data-testid="nodes-join-no-url">
            {t('nodes.enrollment.missingHubUrl')}
          </p>
        ))}

      {pendings.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="nodes-pending-list">
          {pendings.map((pending) => {
            const id = pending.hubEnrollmentId;
            const unconfirmed = hubUnconfirmedIds.includes(id);
            return (
              <li
                key={id}
                className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-2 py-1.5 text-xs"
                data-testid={`nodes-pending-${id}`}
              >
                <span className="truncate">
                  {unconfirmed
                    ? t('nodes.enrollment.hubNotConfirmed')
                    : t('nodes.enrollment.pending')}
                  <span className="ml-2 font-mono text-muted-foreground">
                    {pending.name ?? pending.enrollPk.slice(0, 12)}
                  </span>
                </span>
                <Button
                  type="button"
                  size="xs"
                  disabled={busyPendingId === id}
                  onClick={() => onConfirm(pending)}
                  data-testid={`nodes-pending-confirm-${id}`}
                >
                  {busyPendingId === id ? <Loader2 className="animate-spin" /> : <Check />}
                  {unconfirmed
                    ? t('nodes.enrollment.retryHub')
                    : t('nodes.enrollment.confirmPending')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * join 命令里的 hub 地址：**只**来自 hub —— enrollment 创建响应的 `public_url`，
 * 或 `/api/auth/mode` 的 `hubPublicUrl`。两者都没有就不生成命令。
 */
export function resolveHubPublicUrl(
  created: { hubPublicUrl: string | null } | null,
  mode: { hubPublicUrl?: string | null }
): string | null {
  return created?.hubPublicUrl ?? mode.hubPublicUrl ?? null;
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

  /**
   * 吊销：**只有一条路径**——`POST /api/auth/keylog?hub=sync`。
   * entry 先把签好的记录送 hub 等 ack，再本地 append。
   * 老实现「本地 append + 再调 hub revoke」是两条独立通道，先到的那条会让另一条报 `seq_gap`，
   * UI 误报 hub 失败；两条都失败时本地却已经把节点从列表里摘掉（见 F4-3 评审 Major）。
   */
  const revoke = useCallback(async () => {
    const confirmed = globalThis.confirm?.(t('nodes.revoke.confirmText', { name: row.name }));
    if (!confirmed) return;
    const password = globalThis.prompt?.(t('nodes.enrollment.passwordPrompt')) ?? '';
    if (!password) return;
    const reason = globalThis.prompt?.(t('nodes.revoke.reasonPrompt')) ?? '';
    setBusy(true);
    try {
      const rootEpoch = requireRootEpoch(mode);
      const head = headFromResponse(await api.keyLogHead());
      const result = await withRootSigner(password, mode.kdfParams, async (signer) => {
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
      });
      if (!result.ok) {
        toast.error(t(`auth.errors.${result.code}`, { defaultValue: result.code }));
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
  }, [api, mode, onChanged, row.id, row.name, t]);

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
