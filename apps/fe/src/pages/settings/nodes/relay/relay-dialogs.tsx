// 中继的两个对话框：接入表单（要本机账号密码）与三个破坏性动作的确认框。
//
// 接入表单单列一个「本机登录密码」输入：接入证明是根钥对 Borsh 结构的 Ed25519 签名，
// 通行密钥给不出这种签名（plan §1.7），所以这一步没有 passkey 分支，必须当场输密码。

import { isTrustedHubUrl } from '@/node/enrollment';
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
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  RelayActionsController,
  RelayConfirmIntent,
  RelayEnrollIntent,
} from './use-relay-actions';

const ENROLL_TITLES: Record<RelayEnrollIntent, string> = {
  enroll: 'relay.tenant.dialog.enrollTitle',
  migrate: 'relay.tenant.dialog.migrateTitle',
  add: 'relay.tenant.dialog.addTitle',
  reauth: 'relay.tenant.dialog.reauthTitle',
};

// 每种来意各说各的：reauth 的地址是锁死的，再提「填公网地址」就是答非所问。
const ENROLL_NOTICES: Record<RelayEnrollIntent, string> = {
  enroll: 'relay.tenant.dialog.urlHint',
  migrate: 'relay.tenant.dialog.migrateNotice',
  add: 'relay.tenant.dialog.urlHint',
  reauth: 'relay.tenant.dialog.reauthNotice',
};

const CONFIRM_COPY: Record<RelayConfirmIntent, { title: string; description: string; ok: string }> =
  {
    leave: {
      title: 'relay.tenant.leave.title',
      description: 'relay.tenant.leave.description',
      ok: 'relay.tenant.leave.confirm',
    },
    rotate: {
      title: 'relay.tenant.metaKey.rotateTitle',
      description: 'relay.tenant.metaKey.rotateDescription',
      ok: 'relay.tenant.metaKey.rotateConfirm',
    },
    remove: {
      title: 'relay.tenant.remove.title',
      description: 'relay.tenant.remove.description',
      ok: 'relay.tenant.remove.confirm',
    },
  };

/** 接入表单能不能提交：地址须是可信 https（回环允许 http），根密码不能空。 */
export function canSubmitRelayEnroll(form: {
  url: string;
  rootPassword: string;
}): boolean {
  return isTrustedHubUrl(form.url.trim()) && form.rootPassword.length > 0;
}

export function RelayEnrollDialog({ actions }: { actions: RelayActionsController }) {
  const open = actions.enroll;
  // key 换成 intent+url：换一次来意就是一张新表单，不能把上一次的口令留在框里。
  return open ? (
    <Dialog
      open
      onOpenChange={(next: boolean) => {
        if (!next) actions.closeEnroll();
      }}
    >
      <DialogContent data-testid="nodes-relay-enroll-dialog">
        <RelayEnrollForm key={`${open.intent}:${open.url}`} actions={actions} />
      </DialogContent>
    </Dialog>
  ) : null;
}

function RelayEnrollForm({ actions }: { actions: RelayActionsController }) {
  const { t } = useTranslation();
  const open = actions.enroll;
  const [url, setUrl] = useState(open?.url ?? '');
  const [password, setPassword] = useState('');
  const [rootPassword, setRootPassword] = useState('');
  if (!open) return null;
  const locked = open.intent === 'reauth';

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t(ENROLL_TITLES[open.intent])}</DialogTitle>
        <DialogDescription>{t(ENROLL_NOTICES[open.intent])}</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-2 text-xs">
        <label className="flex flex-col gap-1" htmlFor="nodes-relay-url">
          {t('relay.tenant.dialog.url')}
          <Input
            id="nodes-relay-url"
            value={url}
            disabled={locked || actions.busy}
            placeholder="https://relay.example.com"
            data-testid="nodes-relay-url"
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1" htmlFor="nodes-relay-password">
          {t('relay.tenant.dialog.password')}
          <Input
            id="nodes-relay-password"
            type="password"
            autoComplete="off"
            value={password}
            disabled={actions.busy}
            data-testid="nodes-relay-password"
            onChange={(event) => setPassword(event.target.value)}
          />
          <span className="text-muted-foreground">{t('relay.tenant.dialog.passwordHint')}</span>
        </label>
        <label className="flex flex-col gap-1" htmlFor="nodes-relay-root-password">
          {t('relay.tenant.dialog.rootPassword')}
          <Input
            id="nodes-relay-root-password"
            type="password"
            autoComplete="current-password"
            value={rootPassword}
            disabled={actions.busy}
            data-testid="nodes-relay-root-password"
            onChange={(event) => setRootPassword(event.target.value)}
          />
          <span className="text-muted-foreground">{t('relay.tenant.dialog.rootPasswordHint')}</span>
        </label>
        {actions.error && (
          <p className="text-destructive" data-testid="nodes-relay-enroll-error">
            {actions.error}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={actions.busy}
          onClick={actions.closeEnroll}
          data-testid="nodes-relay-enroll-cancel"
        >
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={actions.busy || !canSubmitRelayEnroll({ url, rootPassword })}
          onClick={() => void actions.submitEnroll({ url, password, rootPassword })}
          data-testid="nodes-relay-enroll-submit"
        >
          {actions.busy && <Loader2 className="animate-spin motion-reduce:animate-none" />}
          {t(
            open.intent === 'reauth'
              ? 'relay.tenant.dialog.submitReauth'
              : 'relay.tenant.dialog.submit'
          )}
        </Button>
      </DialogFooter>
    </>
  );
}

export function RelayConfirmDialog({ actions }: { actions: RelayActionsController }) {
  const { t } = useTranslation();
  const request = actions.confirm;
  if (!request) return null;
  const copy = CONFIRM_COPY[request.intent];
  return (
    <AlertDialog
      open
      onOpenChange={(next: boolean) => {
        if (!next) actions.dismissConfirm();
      }}
    >
      <AlertDialogContent data-testid="nodes-relay-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t(copy.title)}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(copy.description, { url: request.url ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={actions.dismissConfirm}
            data-testid="nodes-relay-confirm-cancel"
          >
            {t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={request.intent === 'rotate' ? undefined : 'destructive'}
            disabled={actions.busy}
            onClick={() => void actions.runConfirm()}
            data-testid="nodes-relay-confirm-ok"
          >
            {t(copy.ok)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
