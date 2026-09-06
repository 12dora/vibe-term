// 「分享」标签里与密码有关的两个对话框（查看 / 修改）与「复制带密码的链接」。
//
// 三件事都要先把明文密码从服务端取回来，失败形态也共用一套：旧版本创建的分享库里只有
// 不可逆的哈希，服务端答 409，这时只能说「看不了，直接改」，不能笼统报「操作失败」。
//
// 状态与对话框元素一起由 `useSharePasswordDialogs` 交出：表格行只管把动作抛上来，
// 「分享」标签只管把元素摆下去，两边都不必知道这里有几个对话框、各自有几种状态。

import { buildShareLinkWithPassword } from '@/share/share-link-password';
import { ApiError } from '@tmex/api-client';
import { writeTextToClipboard } from '@tmex/shared';
import type { ShareRecord } from '@tmex/shared/share';
import { SHARE_PASSWORD_MIN_LENGTH, generateSharePassword } from '@tmex/shared/share';
import { Button } from '@tmex/ui/button';
import { Checkbox } from '@tmex/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { Input } from '@tmex/ui/input';
import { toast } from '@tmex/ui/toast';
import { Eye, EyeOff, Loader2, RefreshCw } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../components/form-primitives';
import { CopyButton } from '../nodes/copy-feedback';
import { shareErrorKey } from './share-api';
import type { ShareTabModel } from './use-share-tab';

const MASKED = '••••••••';

/** 界面要自己带插值参数，翻译函数只能按这个形状取。 */
type Translate = (key: string, params?: Record<string, unknown>) => string;

export interface SharePasswordError {
  key: string;
  params?: Record<string, unknown>;
}

type LoadPassword = (shareId: string) => Promise<string>;
type ChangePassword = (shareId: string, password: string, endSessions: boolean) => Promise<number>;

/**
 * 旧分享（0048 之前创建，库里只有哈希）的 409 在设置页要说清「只能改」，
 * 与分享弹窗那句通用的「无法查看」不同，故在这里点名覆盖；其余失败退回分享通用映射。
 */
function passwordErrorKey(error: unknown): string {
  return error instanceof ApiError && error.code === 'SHARE_PASSWORD_UNAVAILABLE'
    ? 'settings.share.active.passwordHidden'
    : shareErrorKey(error);
}

export async function copyShareLinkWithPassword(
  share: ShareRecord,
  load: LoadPassword,
  t: Translate
): Promise<void> {
  try {
    const password = await load(share.id);
    await writeTextToClipboard(buildShareLinkWithPassword(share.url, password));
    toast.success(t('settings.share.active.linkCopied'));
  } catch (error) {
    toast.error(t(passwordErrorKey(error)));
  }
}

export interface ChangePasswordDraft {
  password: string;
  endSessions: boolean;
}

export function validateSharePasswordDraft(draft: ChangePasswordDraft): SharePasswordError | null {
  return draft.password.trim().length < SHARE_PASSWORD_MIN_LENGTH
    ? { key: 'share.error.passwordTooShort', params: { min: SHARE_PASSWORD_MIN_LENGTH } }
    : null;
}

/** 提交改密码：成功给 toast 并返回 `null`，失败返回要就地摆出来的错误。 */
export async function submitSharePasswordChange(
  shareId: string,
  draft: ChangePasswordDraft,
  change: ChangePassword,
  t: Translate
): Promise<SharePasswordError | null> {
  const invalid = validateSharePasswordDraft(draft);
  if (invalid) return invalid;
  try {
    const ended = await change(shareId, draft.password.trim(), draft.endSessions);
    toast.success(
      ended > 0
        ? t('settings.share.active.passwordChangedAndEnded', { count: ended })
        : t('settings.share.active.passwordChanged')
    );
    return null;
  } catch (error) {
    return { key: passwordErrorKey(error) };
  }
}

export interface SharePasswordValue {
  loading: boolean;
  password: string | null;
  /** 取密码失败的 i18n key。 */
  errorKey: string | null;
}

const IDLE: SharePasswordValue = { loading: false, password: null, errorKey: null };

function useSharePasswordValue(shareId: string | null, load: LoadPassword): SharePasswordValue {
  const [value, setValue] = useState<SharePasswordValue>(IDLE);
  useEffect(() => {
    if (shareId === null) {
      setValue(IDLE);
      return;
    }
    let live = true;
    setValue({ loading: true, password: null, errorKey: null });
    load(shareId).then(
      (password) => {
        if (live) setValue({ loading: false, password, errorKey: null });
      },
      (error) => {
        if (live) setValue({ loading: false, password: null, errorKey: passwordErrorKey(error) });
      }
    );
    return () => {
      live = false;
    };
  }, [shareId, load]);
  return value;
}

/** 单独导出：对话框走 portal，静态渲染只看得到这一块。 */
export function ViewSharePasswordBody({ value }: { value: SharePasswordValue }) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  if (value.loading) {
    return (
      <div className="flex justify-center py-4" data-testid="share-password-loading">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (value.errorKey) {
    return (
      <Notice tone="error" testId="share-password-unavailable">
        {t(value.errorKey)}
      </Notice>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid="share-password-body">
      <span className="text-xs text-muted-foreground">{t('settings.share.active.password')}</span>
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 break-all rounded bg-muted/50 px-2 py-1 font-mono text-xs"
          data-testid="share-password-value"
        >
          {revealed ? (value.password ?? '') : MASKED}
        </code>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={t(revealed ? 'shareAccess.hidePassword' : 'shareAccess.showPassword')}
          onClick={() => setRevealed((next) => !next)}
          data-testid="share-password-reveal"
        >
          {revealed ? <EyeOff /> : <Eye />}
        </Button>
        <CopyButton value={value.password ?? ''} testId="share-password" variant="outline" />
      </div>
    </div>
  );
}

function ViewSharePasswordDialog({
  share,
  load,
  onClose,
}: { share: ShareRecord | null; load: LoadPassword; onClose: () => void }) {
  const { t } = useTranslation();
  const value = useSharePasswordValue(share?.id ?? null, load);
  return (
    <Dialog
      open={share !== null}
      onOpenChange={(next: boolean) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="share-password-dialog">
        <DialogHeader>
          <DialogTitle>{t('settings.share.active.viewPassword')}</DialogTitle>
          <DialogDescription>{share?.name ?? ''}</DialogDescription>
        </DialogHeader>
        <ViewSharePasswordBody value={value} />
      </DialogContent>
    </Dialog>
  );
}

/** 单独导出：同上，静态渲染只看得到这一块。 */
export function ChangeSharePasswordBody({
  draft,
  error,
  onChange,
}: {
  draft: ChangePasswordDraft;
  error: SharePasswordError | null;
  onChange: (next: ChangePasswordDraft) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="share-change-password-body">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground" htmlFor="share-change-password-input">
          {t('settings.share.active.newPassword')}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="share-change-password-input"
            className="font-mono"
            value={draft.password}
            autoComplete="off"
            data-testid="share-change-password-input"
            onChange={(event) => onChange({ ...draft, password: event.target.value })}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onChange({ ...draft, password: generateSharePassword() })}
            data-testid="share-change-password-generate"
          >
            <RefreshCw />
            {t('settings.share.active.generate')}
          </Button>
        </div>
      </div>

      <label className="flex items-start gap-2 text-xs" htmlFor="share-change-password-end">
        <Checkbox
          id="share-change-password-end"
          checked={draft.endSessions}
          onCheckedChange={(next) => onChange({ ...draft, endSessions: next === true })}
          data-testid="share-change-password-end-sessions"
        />
        <span className="flex flex-col gap-0.5">
          {t('settings.share.active.endSessions')}
          <span className="text-muted-foreground">
            {t('settings.share.active.endSessionsHint')}
          </span>
        </span>
      </label>

      {error && (
        <Notice tone="error" testId="share-change-password-error">
          {t(error.key, error.params)}
        </Notice>
      )}
    </div>
  );
}

function newDraft(): ChangePasswordDraft {
  return { password: generateSharePassword(), endSessions: false };
}

function ChangeSharePasswordDialog({
  share,
  busy,
  change,
  onClose,
}: {
  share: ShareRecord | null;
  busy: boolean;
  change: ChangePassword;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ChangePasswordDraft>(newDraft);
  const [error, setError] = useState<SharePasswordError | null>(null);
  const shareId = share?.id ?? null;

  // 每次开框都换一份新的建议密码：把上一条分享的草稿留下来只会被误提交。
  useEffect(() => {
    if (shareId === null) return;
    setDraft(newDraft());
    setError(null);
  }, [shareId]);

  const submit = () => {
    if (shareId === null) return;
    void submitSharePasswordChange(shareId, draft, change, t).then((failure) => {
      setError(failure);
      if (!failure) onClose();
    });
  };

  return (
    <Dialog
      open={share !== null}
      onOpenChange={(next: boolean) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="share-change-password-dialog">
        <DialogHeader>
          <DialogTitle>{t('settings.share.active.changePasswordTitle')}</DialogTitle>
          <DialogDescription>{share?.name ?? ''}</DialogDescription>
        </DialogHeader>
        <ChangeSharePasswordBody draft={draft} error={error} onChange={setDraft} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={submit}
            data-testid="share-change-password-submit"
          >
            {busy && <Loader2 className="animate-spin" />}
            {t('settings.share.active.changePassword')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type SharePasswordAction = 'view' | 'change' | 'copy-link';

export interface SharePasswordDialogs {
  open: (action: SharePasswordAction, share: ShareRecord) => void;
  dialogs: ReactNode;
}

export function useSharePasswordDialogs(model: ShareTabModel): SharePasswordDialogs {
  const { t } = useTranslation();
  const [viewing, setViewing] = useState<ShareRecord | null>(null);
  const [changing, setChanging] = useState<ShareRecord | null>(null);
  const { fetchPassword, changePassword } = model;

  const open = useCallback(
    (action: SharePasswordAction, share: ShareRecord) => {
      if (action === 'view') setViewing(share);
      else if (action === 'change') setChanging(share);
      else void copyShareLinkWithPassword(share, fetchPassword, t);
    },
    [fetchPassword, t]
  );

  return {
    open,
    dialogs: (
      <>
        <ViewSharePasswordDialog
          share={viewing}
          load={fetchPassword}
          onClose={() => setViewing(null)}
        />
        <ChangeSharePasswordDialog
          share={changing}
          busy={model.busyShareId !== null}
          change={changePassword}
          onClose={() => setChanging(null)}
        />
      </>
    ),
  };
}
