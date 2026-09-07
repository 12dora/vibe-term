// 租户的两个破坏性动作的确认框。
//
// 踢出可逆（重新输入口令即可再接入），用通用的危险确认框；
// 删除不可逆（注册表与密钥日志一并删掉），要求逐字敲出租户编号才放行。

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@vibeterm/ui/alert-dialog';
import { Input } from '@vibeterm/ui/input';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DangerConfirmDialog } from '../components/danger-confirm-dialog';
import { Notice } from '../components/form-primitives';
import type { RelayOfflineGuard } from './use-relay-controller';

export function KickTenantConfirm({
  tenantId,
  busy,
  onCancel,
  onConfirm,
}: {
  tenantId: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (tenantId === null) return null;
  return (
    <DangerConfirmDialog
      open
      title={t('relay.admin.tenants.kickTitle')}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('relay.admin.tenants.kick')}
      onCancel={() => {
        if (!busy) onCancel();
      }}
      onConfirm={onConfirm}
      testId="relay-tenant-kick-dialog"
      confirmTestId="relay-tenant-kick-confirm"
    >
      <span className="block">{t('relay.admin.tenants.kickText')}</span>
      <span className="mt-2 block font-mono break-all">{tenantId}</span>
    </DangerConfirmDialog>
  );
}

/**
 * 「还有成员离线」的二次确认（服务端 409 `relay_members_offline` 之后）。
 *
 * 作废旧令牌**没有宽限**：此刻离线的成员回来时手里那把令牌已经作废，中继连认证都不给过，
 * 追不上后面任何一条记录。因此这里必须同时给出人数与恢复链，而不是笼统一句「确定吗」。
 */
export function RelayOfflineForceConfirm({
  request,
  busy,
  onCancel,
  onConfirm,
}: {
  request: RelayOfflineGuard | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (request === null) return null;
  return (
    <DangerConfirmDialog
      open
      title={t(`relay.admin.offlineGuard.${request.kind}Title`)}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('relay.admin.offlineGuard.confirm')}
      confirmDisabled={busy}
      onCancel={() => {
        if (!busy) onCancel();
      }}
      onConfirm={onConfirm}
      testId="relay-offline-guard-dialog"
      confirmTestId="relay-offline-guard-confirm"
    >
      <span className="block" data-testid="relay-offline-guard-counts">
        {t('relay.admin.offlineGuard.counts', {
          online: request.online,
          admitted: request.admitted,
        })}
      </span>
      <span className="mt-2 block">{t('relay.admin.offlineGuard.consequence')}</span>
      <span className="mt-2 block">{t('relay.admin.offlineGuard.recovery')}</span>
    </DangerConfirmDialog>
  );
}

/** 删除确认的正文。单独导出：AlertDialog 走 portal，静态渲染只看得到这一块。 */
export function DeleteTenantBody({
  tenantId,
  typed,
  busy,
  error,
  onTyped,
}: {
  tenantId: string;
  typed: string;
  busy: boolean;
  error: string | null;
  onTyped: (next: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2" data-testid="relay-tenant-remove-body">
      <p className="text-xs text-muted-foreground">{t('relay.admin.tenants.removeText')}</p>
      <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] break-all">
        {tenantId}
      </code>
      <label className="text-xs font-medium" htmlFor="relay-tenant-remove-input">
        {t('relay.admin.tenants.removeConfirmLabel')}
      </label>
      <Input
        id="relay-tenant-remove-input"
        value={typed}
        disabled={busy}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onTyped(event.target.value)}
        data-testid="relay-tenant-remove-input"
      />
      {typed !== '' && typed !== tenantId && (
        <p className="text-xs text-destructive" data-testid="relay-tenant-remove-mismatch">
          {t('relay.admin.tenants.removeMismatch')}
        </p>
      )}
      {error && (
        <Notice tone="error" testId="relay-tenant-remove-error">
          {error}
        </Notice>
      )}
    </div>
  );
}

export function DeleteTenantConfirm({
  tenantId,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  tenantId: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  // 输入框只靠重挂清空（调用点按租户编号给 key），不另装一条「prop 变了就 setState」的副作用。
  const [typed, setTyped] = useState('');

  if (tenantId === null) return null;

  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <AlertDialogContent data-testid="relay-tenant-remove-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('relay.admin.tenants.removeTitle')}</AlertDialogTitle>
          <AlertDialogDescription className="sr-only">
            {t('relay.admin.tenants.removeText')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <DeleteTenantBody
          tenantId={tenantId}
          typed={typed}
          busy={busy}
          error={error}
          onTyped={setTyped}
        />

        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={onCancel}
            disabled={busy}
            data-testid="relay-tenant-remove-cancel"
          >
            {t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy || typed !== tenantId}
            onClick={onConfirm}
            data-testid="relay-tenant-remove-confirm"
          >
            {busy && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            {t('relay.admin.tenants.remove')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
