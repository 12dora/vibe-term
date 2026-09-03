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
} from '@tmex/ui/alert-dialog';
import { Input } from '@tmex/ui/input';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DangerConfirmDialog } from '../components/danger-confirm-dialog';
import { Notice } from '../components/form-primitives';

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
