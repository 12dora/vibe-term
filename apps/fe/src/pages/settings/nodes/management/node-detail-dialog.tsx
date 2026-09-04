// 节点详情：只读信息 + 两个可改项（名称、允许域名访问）。
//
// 名称经 hub 控制面改（与节点表的旧行内重命名同一个接口），域名访问是**节点本地策略**，
// 经 `/n/<id>/api/system/domain-access` 直接问那台机器——两条通道各自成败，保存时分别报错。
//
// 关闭域名访问要过一道确认：经配置的公开域名随即只剩 Hub / 节点互联流量，若当前这一页正是
// 从该域名进来的（`viaDomain`），点下去就会当场失联。

import type { NodeRow } from '@/node/mesh-nodes';
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
import { useTranslation } from 'react-i18next';
import { CopyButton } from '../copy-feedback';
import { hubModeLabel } from '../uplink/hub-strip';
import {
  type DomainAccessState,
  type NodeDetailIo,
  type Translate,
  hasNodeDetailChanges,
} from './node-detail-types';
import { useNodeDetailState } from './use-node-detail-state';

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

/**
 * 域名访问开关是否锁住。
 *
 * 没有公开域名时「关闭」不解决任何问题（本来就没有公网入口），却会把这台机器锁在
 * 「只能从局域网开回来」的状态里——与本机那一行同一条判据：当前是开着的就不给关。
 * 当前已经是关的则允许开回来，否则用户没有任何路径把它恢复。
 */
export function domainAccessSwitchDisabled(
  state: DomainAccessState,
  allowed: boolean | null
): boolean {
  if (allowed === null) return true;
  return state.kind === 'ready' && state.hosts.length === 0 && state.allowed;
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
  const switchDisabled = domainAccessSwitchDisabled(domainAccess, allowed);

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
  const { state, patch, plan, save, onAllowedChange } = useNodeDetailState(row, open, {
    io,
    rename,
    writerPublicUrl,
    onChanged,
    onOpenChange,
  });

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
