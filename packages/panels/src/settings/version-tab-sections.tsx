// 版本设置页的展示块：信息行、更新检查行、变更日志、升级进度、升级确认弹窗。
// 数据与动作由 ./use-version-tab 提供，这里只负责渲染。

import type { SystemInfo, UpdateCheckResult } from '@tmex/shared';
import { formatDate } from '@tmex/shared';
import { useSiteStore } from '@tmex/stores/react';
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
import { AlertTriangle, Download, Loader2, RefreshCw } from 'lucide-react';
import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';

// 变更日志才用得到 Markdown 渲染链（约 137 KiB gzip），设置页其余部分不该为它买单。
const MarkdownPreview = lazy(() =>
  import('../markdown/markdown-preview').then((m) => ({ default: m.MarkdownPreview }))
);

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-2.5">
      <div className="min-w-0 pr-2 text-sm font-medium">{label}</div>
      <div className="min-w-0 truncate text-right text-sm text-muted-foreground">{value}</div>
    </div>
  );
}

export function VersionInfoRows({
  info,
  deploymentLabel,
}: {
  info?: SystemInfo;
  deploymentLabel: (deployment: SystemInfo['deployment']) => string;
}) {
  const { t } = useTranslation();
  const installMethod = info?.installedViaCli
    ? t('settings.version.installMethodCli')
    : t('settings.version.installMethodNonCli');
  return (
    <div className="space-y-3">
      <InfoRow
        label={t('settings.version.currentVersion')}
        value={
          <span data-testid="settings-version-current" className="font-mono">
            {info ? info.version : t('common.loading')}
          </span>
        }
      />
      <InfoRow label={t('settings.version.installMethod')} value={info ? installMethod : '-'} />
      <InfoRow
        label={t('settings.version.deployment')}
        value={info ? deploymentLabel(info.deployment) : '-'}
      />
    </div>
  );
}

function LatestVersionText({ update }: { update: UpdateCheckResult }) {
  const { t } = useTranslation();
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');
  const headline =
    update.hasUpdate && update.latestVersion
      ? t('settings.version.updateAvailable', { version: update.latestVersion })
      : t('settings.version.upToDate');
  const published = update.publishedAt
    ? ` · ${t('settings.version.publishedAt', { date: formatDate(update.publishedAt, language) })}`
    : '';
  return (
    <span className="text-sm text-muted-foreground" data-testid="settings-version-latest">
      {headline}
      {published}
    </span>
  );
}

export function UpdateCheckRow({
  update,
  isChecking,
  disabled,
  onCheck,
}: {
  update?: UpdateCheckResult;
  isChecking: boolean;
  disabled: boolean;
  onCheck: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        variant="outline"
        data-testid="settings-version-check"
        onClick={onCheck}
        disabled={disabled}
      >
        {isChecking ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        {isChecking ? t('settings.version.checking') : t('settings.version.checkUpdate')}
      </Button>

      {update && <LatestVersionText update={update} />}
    </div>
  );
}

export function ChangelogSection({
  changelog,
  canSelfUpdate,
  disabledReason,
  upgradeDisabled,
  onUpgrade,
  isUpgrading,
}: {
  changelog?: string | null;
  canSelfUpdate: boolean;
  disabledReason: string | null;
  upgradeDisabled: boolean;
  onUpgrade: () => void;
  isUpgrading: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold">{t('settings.version.changelog')}</div>
      <div className="rounded-lg border border-border bg-card px-4 py-3">
        {changelog ? (
          <Suspense fallback={<Loader2 className="h-4 w-4 animate-spin" />}>
            <MarkdownPreview source={changelog} basePath="/" />
          </Suspense>
        ) : (
          <div className="text-sm text-muted-foreground">
            {t('settings.version.changelogUnavailable')}
          </div>
        )}
      </div>

      {canSelfUpdate ? (
        <Button
          variant="secondary"
          data-testid="settings-version-upgrade"
          disabled={upgradeDisabled}
          onClick={onUpgrade}
        >
          {isUpgrading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {t('settings.version.upgrade')}
        </Button>
      ) : (
        <div className="space-y-1">
          {disabledReason && <div className="text-sm text-muted-foreground">{disabledReason}</div>}
          <div className="text-xs text-muted-foreground font-mono">
            {t('settings.version.terminalHint')}
          </div>
        </div>
      )}
    </div>
  );
}

export function UpgradeProgress({ stateText }: { stateText: string }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-border bg-card px-4 py-3"
      data-testid="settings-version-upgrade-status"
    >
      <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
      <div className="space-y-1">
        <div className="text-sm font-medium">{stateText}</div>
        <div className="text-xs text-muted-foreground">{t('settings.version.interruptNotice')}</div>
      </div>
    </div>
  );
}

export function UpgradeConfirmDialog({
  open,
  onOpenChange,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            {t('settings.version.upgradeWarningTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('settings.version.upgradeWarningBody')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid="settings-version-upgrade-confirm"
            onClick={onConfirm}
          >
            {t('settings.version.upgrade')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
