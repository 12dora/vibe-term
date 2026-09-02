// 节点详情：只读信息 + 两个可改项（名称、允许域名访问）。
//
// 名称经 hub 控制面改（与节点表的旧行内重命名同一个接口），域名访问是**节点本地策略**，
// 经 `/n/<id>/api/system/domain-access` 直接问那台机器——两条通道各自成败，保存时分别报错。
//
// 关闭域名访问要过一道确认：经配置的公开域名随即只剩 Hub / 节点互联流量，若当前这一页正是
// 从该域名进来的（`viaDomain`），点下去就会当场失联。

import type { NodeRow } from '@/node/mesh-nodes';
import {
  type ApiClient,
  type DomainAccessPolicy,
  createNodeApiClient,
  fetchDomainAccess,
  updateDomainAccess,
} from '@tmex/api-client';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Button } from '@tmex/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { Input } from '@tmex/ui/input';
import { Switch } from '@tmex/ui/switch';
import { Loader2, Save } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CopyButton } from '../copy-feedback';
import { actionErrorText } from './errors';
import { hubModeLabel } from './hub-strip';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 老节点没有这个端点：入口转发回 404 / 405，一律折成「该节点版本不支持」。 */
const UNSUPPORTED_STATUS = new Set([404, 405]);

export type DomainAccessState =
  | { kind: 'loading' }
  | { kind: 'ready'; allowed: boolean; viaDomain: boolean; hosts: string[] }
  | { kind: 'unsupported' }
  | { kind: 'failed'; message: string };

/** 目标节点的 REST 客户端：本机退化成无前缀，远端走 `/n/<id>`。 */
export function nodeDetailClient(row: NodeRow): ApiClient {
  return createNodeApiClient(row.runtimeNodeId);
}

export interface NodeDetailIo {
  loadDomainAccess: (row: NodeRow) => Promise<DomainAccessPolicy>;
  saveDomainAccess: (row: NodeRow, allowed: boolean) => Promise<DomainAccessPolicy>;
  rename: (name: string) => Promise<void>;
}

export function createNodeDetailIo(rename: (name: string) => Promise<void>): NodeDetailIo {
  return {
    loadDomainAccess: (row) => fetchDomainAccess(nodeDetailClient(row)),
    saveDomainAccess: (row, allowed) => updateDomainAccess(allowed, nodeDetailClient(row)),
    rename,
  };
}

export async function loadDomainAccessState(
  row: NodeRow,
  io: Pick<NodeDetailIo, 'loadDomainAccess'>,
  t: Translate
): Promise<DomainAccessState> {
  try {
    const policy = await io.loadDomainAccess(row);
    return {
      kind: 'ready',
      allowed: policy.allowed,
      viaDomain: policy.viaDomain === true,
      hosts: policy.hosts ?? [],
    };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== undefined && UNSUPPORTED_STATUS.has(status)) return { kind: 'unsupported' };
    return { kind: 'failed', message: actionErrorText(t, err) };
  }
}

/** Switch 的开关请求：关闭是破坏性动作，先过确认框；打开直接落到草稿上。 */
export function toggleDomainAccess(
  next: boolean
): { kind: 'apply'; allowed: boolean } | { kind: 'confirm' } {
  return next ? { kind: 'apply', allowed: true } : { kind: 'confirm' };
}

export interface NodeDetailValues {
  name: string;
  /** 域名访问；未加载 / 不支持 / 读取失败时为 `null`，此项不参与保存。 */
  allowed: boolean | null;
}

export interface NodeDetailPlan {
  /** 要改的名字（已 trim）；不改名时为 `null`。 */
  renameTo: string | null;
  /** 要写的域名访问策略；不改时为 `null`。 */
  allowed: boolean | null;
}

export function planNodeDetailSave(
  baseline: NodeDetailValues,
  draft: NodeDetailValues
): NodeDetailPlan {
  const name = draft.name.trim();
  const allowedChanged =
    baseline.allowed !== null && draft.allowed !== null && draft.allowed !== baseline.allowed;
  return {
    renameTo: name && name !== baseline.name ? name : null,
    allowed: allowedChanged ? draft.allowed : null,
  };
}

export function hasNodeDetailChanges(plan: NodeDetailPlan): boolean {
  return plan.renameTo !== null || plan.allowed !== null;
}

export interface NodeDetailSaveContext {
  t: Translate;
  writerPublicUrl: string | null;
}

export interface NodeDetailSaveResult {
  ok: boolean;
  errors: string[];
}

/** 两条通道各自执行、各自报错：改名失败不该把已经改好的域名访问一起吞掉。 */
export async function saveNodeDetail(
  row: NodeRow,
  plan: NodeDetailPlan,
  io: NodeDetailIo,
  { t, writerPublicUrl }: NodeDetailSaveContext
): Promise<NodeDetailSaveResult> {
  const errors: string[] = [];
  if (plan.renameTo !== null) {
    try {
      await io.rename(plan.renameTo);
    } catch (err) {
      errors.push(
        t('nodes.detail.renameFailed', { error: actionErrorText(t, err, { writerPublicUrl }) })
      );
    }
  }
  if (plan.allowed !== null) {
    try {
      await io.saveDomainAccess(row, plan.allowed);
    } catch (err) {
      errors.push(t('nodes.detail.domainAccessSaveFailed', { error: actionErrorText(t, err) }));
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const TRANSPORT_KEYS: Record<string, string> = {
  'ws-secure': 'nodes.badge.transportWs',
  dc: 'nodes.badge.transportDc',
  relay: 'nodes.badge.transportRelay',
};

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-xs">{children}</span>
    </div>
  );
}

/** 只读信息区。单独导出：Dialog 走 portal，静态渲染只看得到这一块。 */
export function NodeDetailInfo({ row }: { row: NodeRow }) {
  const { t } = useTranslation();
  const transportKey = row.transport ? TRANSPORT_KEYS[row.transport] : undefined;
  return (
    <div className="flex flex-col gap-1.5" data-testid={`nodes-detail-info-${row.id}`}>
      <InfoRow label={t('nodes.detail.nodeId')}>
        <span className="flex items-center gap-1">
          <code className="rounded bg-muted/50 px-1.5 py-0.5 text-[11px]">
            {row.id.slice(0, 8)}
          </code>
          <CopyButton value={row.id} testId={`nodes-detail-id-${row.id}`} />
        </span>
      </InfoRow>
      <InfoRow label={t('nodes.columns.fingerprint')}>
        <code className="font-mono text-[11px] text-muted-foreground">{row.fingerprint}</code>
      </InfoRow>
      <InfoRow label={t('nodes.columns.version')}>{row.version ?? '—'}</InfoRow>
      <InfoRow label={t('nodes.columns.reach')}>
        {row.reach ? t(`nodes.reach.${row.reach}`) : '—'}
        {transportKey ? `｜${t(transportKey)}` : ''}
      </InfoRow>
      <InfoRow label={t('nodes.columns.lastSeen')}>
        {row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : '—'}
      </InfoRow>
      <InfoRow label={t('nodes.columns.status')}>
        <span className="flex flex-wrap items-center gap-1">
          <span className={row.online ? 'text-emerald-500' : 'text-muted-foreground'}>
            {t(row.online ? 'nodes.status.online' : 'nodes.status.offline')}
          </span>
          {row.isSelf && <DetailTag>{t('nodes.self')}</DetailTag>}
          {row.isHub && <DetailTag>{hubModeLabel(t, row.hubMode ?? null)}</DetailTag>}
        </span>
      </InfoRow>
    </div>
  );
}

function DetailTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}

/** 域名访问那一段的辅助文字：读取中 / 不支持 / 失败原因 / 生效的域名。 */
export function domainAccessNote(state: DomainAccessState, t: Translate): string {
  if (state.kind === 'loading') return t('nodes.detail.domainAccessLoading');
  if (state.kind === 'unsupported') return t('nodes.detail.domainAccessUnsupported');
  if (state.kind === 'failed')
    return t('nodes.detail.domainAccessFailed', { error: state.message });
  if (state.hosts.length > 0) {
    return t('nodes.detail.domainAccessHosts', { hosts: state.hosts.join('、') });
  }
  return t('nodes.detail.domainAccessDescription');
}

export interface NodeDetailBodyProps {
  row: NodeRow;
  name: string;
  onNameChange: (name: string) => void;
  renameAvailable: boolean;
  domainAccess: DomainAccessState;
  allowed: boolean | null;
  onAllowedChange: (next: boolean) => void;
  errors: string[];
}

/** 对话框正文。单独导出，供静态渲染的单测直接断言。 */
export function NodeDetailBody({
  row,
  name,
  onNameChange,
  renameAvailable,
  domainAccess,
  allowed,
  onAllowedChange,
  errors,
}: NodeDetailBodyProps) {
  const { t } = useTranslation();
  const switchDisabled = allowed === null;

  return (
    <div className="flex flex-col gap-4" data-testid={`nodes-detail-body-${row.id}`}>
      <NodeDetailInfo row={row} />

      <div className="space-y-1.5">
        <label className="block text-xs font-medium" htmlFor={`nodes-detail-name-${row.id}`}>
          {t('nodes.detail.name')}
        </label>
        <Input
          id={`nodes-detail-name-${row.id}`}
          value={name}
          disabled={!renameAvailable}
          placeholder={t('nodes.detail.namePlaceholder')}
          onChange={(event) => onNameChange(event.target.value)}
          className="h-9"
          data-testid={`nodes-detail-name-input-${row.id}`}
        />
        {!renameAvailable && (
          <p className="text-[11px] text-muted-foreground">{t('nodes.detail.renameUnavailable')}</p>
        )}
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <span className="block text-xs font-medium">{t('nodes.detail.domainAccess')}</span>
          <p className="text-[11px] text-muted-foreground">{domainAccessNote(domainAccess, t)}</p>
        </div>
        <Switch
          checked={allowed ?? false}
          disabled={switchDisabled}
          aria-label={t('nodes.detail.domainAccess')}
          onCheckedChange={(next) => onAllowedChange(next === true)}
          data-testid={`nodes-detail-domain-${row.id}`}
        />
      </div>

      {errors.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid={`nodes-detail-errors-${row.id}`}>
          {errors.map((message) => (
            <li key={message} className="text-[11px] text-destructive">
              {message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface NodeDetailDialogProps {
  row: NodeRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 改名当前可用（有可写的 hub）。 */
  renameAvailable: boolean;
  writerPublicUrl: string | null;
  rename: (name: string) => Promise<void>;
  onChanged: () => void;
  /** 测试注入；缺省走真实端点。 */
  io?: NodeDetailIo;
}

interface NodeDetailState {
  baseline: NodeDetailValues;
  name: string;
  allowed: boolean | null;
  domainAccess: DomainAccessState;
  errors: string[];
  confirming: boolean;
  saving: boolean;
}

function initialState(row: NodeRow): NodeDetailState {
  return {
    baseline: { name: row.name, allowed: null },
    name: row.name,
    allowed: null,
    domainAccess: { kind: 'loading' },
    errors: [],
    confirming: false,
    saving: false,
  };
}

export function NodeDetailDialog({
  row,
  open,
  onOpenChange,
  renameAvailable,
  writerPublicUrl,
  rename,
  onChanged,
  io,
}: NodeDetailDialogProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<NodeDetailState>(() => initialState(row));
  const patch = useCallback(
    (next: Partial<NodeDetailState>) => setState((prev) => ({ ...prev, ...next })),
    []
  );

  // 列表每次轮询都会换一批新的 row 对象，io / rename 也随宿主重渲染重建：把它们收进 ref，
  // 加载效应才能只认「哪一行、开没开」，不被这些身份变化反复重跑。
  const latest = useRef({ row, io, rename, t });
  latest.current = { row, io, rename, t };
  const rowId = row.id;

  // 基线在打开这一刻定下（域名访问读回来后补上），之后不再跟着列表刷新走：
  // 轮询把 row.name 换掉时若跟着重置草稿，用户输一半的名字会凭空消失。
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowId 是「换了一行」的显式触发器，行对象本身走 ref
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const { row: target, io: injected, rename: renameNode, t: translate } = latest.current;
    setState(initialState(target));
    void loadDomainAccessState(target, injected ?? createNodeDetailIo(renameNode), translate).then(
      (domainAccess) => {
        if (!alive) return;
        const allowed = domainAccess.kind === 'ready' ? domainAccess.allowed : null;
        setState((prev) => ({
          ...prev,
          domainAccess,
          allowed,
          baseline: { ...prev.baseline, allowed },
        }));
      }
    );
    return () => {
      alive = false;
    };
  }, [open, rowId]);

  const plan = planNodeDetailSave(state.baseline, { name: state.name, allowed: state.allowed });

  const save = async () => {
    patch({ saving: true, errors: [] });
    const effective = io ?? createNodeDetailIo(rename);
    const result = await saveNodeDetail(row, plan, effective, { t, writerPublicUrl });
    patch({ saving: false, errors: result.errors });
    if (!result.ok) return;
    toast.success(t('nodes.detail.saved'));
    onChanged();
    onOpenChange(false);
  };

  const onAllowedChange = (next: boolean) => {
    const action = toggleDomainAccess(next);
    if (action.kind === 'confirm') patch({ confirming: true });
    else patch({ allowed: action.allowed });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid={`nodes-detail-dialog-${row.id}`}>
        <DialogHeader>
          <DialogTitle className="truncate">{row.name}</DialogTitle>
          <DialogDescription>{t('nodes.detail.description')}</DialogDescription>
        </DialogHeader>

        <NodeDetailBody
          row={row}
          name={state.name}
          onNameChange={(name) => patch({ name })}
          renameAvailable={renameAvailable}
          domainAccess={state.domainAccess}
          allowed={state.allowed}
          onAllowedChange={onAllowedChange}
          errors={state.errors}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={state.saving}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="secondary"
            disabled={state.saving || !hasNodeDetailChanges(plan)}
            onClick={() => void save()}
            data-testid={`nodes-detail-save-${row.id}`}
          >
            {state.saving ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" />
            ) : (
              <Save />
            )}
            {t('common.save')}
          </Button>
        </DialogFooter>

        <DomainAccessConfirm
          open={state.confirming}
          viaDomain={state.domainAccess.kind === 'ready' && state.domainAccess.viaDomain}
          onCancel={() => patch({ confirming: false })}
          onConfirm={() => patch({ confirming: false, allowed: false })}
          testId={`nodes-detail-domain-confirm-${row.id}`}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * 「当前正走这个域名」那条警告。单独导出：AlertDialog 走 portal，静态渲染只看得到这一块。
 * `viaDomain` 只对入口自身有意义——转发到远端的请求恒为 false。
 */
export function DomainAccessConfirmBody({
  viaDomain,
  testId,
}: { viaDomain: boolean; testId: string }) {
  const { t } = useTranslation();
  if (!viaDomain) return null;
  return (
    <p className="text-xs text-destructive" data-testid={`${testId}-self-warning`}>
      {t('nodes.detail.disableSelfWarning')}
    </p>
  );
}

export function DomainAccessConfirm({
  open,
  viaDomain,
  onCancel,
  onConfirm,
  testId,
}: {
  open: boolean;
  viaDomain: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  if (!open) return null;

  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('nodes.detail.disableTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('nodes.detail.disableText')}</AlertDialogDescription>
        </AlertDialogHeader>
        <DomainAccessConfirmBody viaDomain={viaDomain} testId={testId} />
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={onConfirm}
            data-testid={`${testId}-accept`}
          >
            {t('nodes.detail.disableConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
