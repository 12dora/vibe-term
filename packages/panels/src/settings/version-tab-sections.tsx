// 「关于」卡的展示块：抬头与说明文字、更新检查、变更日志、升级进度、升级确认弹窗。
// 信息用段落文字表达（像常见软件的「关于」），不用一行一格的列表。
// 数据与动作由 ./use-version-tab 提供，这里只负责渲染。

import type { InstallSource, SystemInfo, UpdateCheckResult } from '@vibeterm/shared';
import { BRAND_LOGO_SRC, PRODUCT_NAME, formatDate } from '@vibeterm/shared';
import { useSiteStore } from '@vibeterm/stores/react';
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
import { Button } from '@vibeterm/ui/button';
import { AlertTriangle, Download, Loader2, RefreshCw } from 'lucide-react';
import { type ReactNode, Suspense, lazy } from 'react';
import { Trans, useTranslation } from 'react-i18next';

// 变更日志才用得到 Markdown 渲染链（约 137 KiB gzip），设置页其余部分不该为它买单。
const MarkdownPreview = lazy(() =>
  import('../markdown/markdown-preview').then((m) => ({ default: m.MarkdownPreview }))
);

/** 本项目与上游的仓库地址：跟着卡片走，不进 i18n（三语都是同一个 URL）。 */
const PROJECT_URL = 'https://github.com/12dora/vibe-term';
const PROJECT_HOST = 'github.com/12dora/vibe-term';
const UPSTREAM_URL = 'https://github.com/krhougs/tmex';
const LICENSE_URL = 'https://github.com/12dora/vibe-term/blob/main/LICENSE';

/** 安装来源对应的整句子句（「通过安装脚本安装」），拼进运行状态那句话里。 */
const INSTALL_SOURCE_KEY: Record<InstallSource, string> = {
  'install-script': 'settings.version.installSourceScript',
  npx: 'settings.version.installSourceNpx',
  cli: 'settings.version.installSourceCli',
  manual: 'settings.version.installSourceManual',
};

/** 老网关不下发 `installSource`：有 CLI 安装产物就按 CLI，否则按手动或容器。 */
function installSourceOf(info: SystemInfo): InstallSource {
  return info.installSource ?? (info.installedViaCli ? 'cli' : 'manual');
}

/**
 * 中文/日文子句里插值的英文词（Hub、npx）两侧要留半角空格，但插值前不知道相邻是不是汉字，
 * 所以拼好整句后统一补：汉字与拉丁字母/数字相邻处加一个空格。英文句子没有汉字，原样返回。
 */
function spaceCjkLatin(text: string): string {
  return text
    .replace(/([\u3040-\u30ff\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([\u3040-\u30ff\u4e00-\u9fff])/g, '$1 $2');
}

function ExternalLink({
  href,
  testId,
  children,
}: { href: string; testId: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid={testId}
      className="text-primary underline underline-offset-2"
    >
      {children}
    </a>
  );
}

/** 抬头：logo、产品名、一句定位、版本号——常见「关于」面板的样子。 */
function AboutHeadline({ info }: { info?: SystemInfo }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-4">
      <span className="block h-14 w-14 shrink-0 overflow-hidden rounded-xl border-2 border-black">
        <img src={BRAND_LOGO_SRC} alt="" className="h-full w-full object-cover" />
      </span>
      <div className="min-w-0 space-y-1">
        <div className="text-lg font-semibold leading-tight tracking-tight">{PRODUCT_NAME}</div>
        <div className="text-sm text-muted-foreground">{t('settings.version.tagline')}</div>
        <div className="text-sm text-muted-foreground" data-testid="settings-version-current">
          {info
            ? t('settings.version.versionLine', { version: info.version })
            : t('common.loading')}
        </div>
      </div>
    </div>
  );
}

/**
 * 运行状态一句话：安装方式、服务管理器、mesh 运行模式（后者由宿主传入）。
 * 拿不到的子句直接省略，不在句子里塞「加载中」或一杠。
 */
function RuntimeSentence({
  info,
  deploymentLabel,
  runMode,
}: {
  info?: SystemInfo;
  deploymentLabel: (deployment: SystemInfo['deployment']) => string | null;
  runMode?: string;
}) {
  const { t } = useTranslation();
  if (!info) return null;
  const service = deploymentLabel(info.deployment);
  const clauses = [
    t(INSTALL_SOURCE_KEY[installSourceOf(info)]),
    service
      ? t('settings.version.runtimeService', { service })
      : t('settings.version.runtimeServiceNone'),
    runMode ? t('settings.version.runtimeRole', { role: runMode }) : null,
  ].filter((clause): clause is string => Boolean(clause));
  const sentence =
    clauses.join(t('settings.version.runtimeSeparator')) + t('settings.version.runtimeEnd');
  return (
    <p
      className="text-sm text-muted-foreground"
      data-testid="settings-version-runtime"
      data-install-source={installSourceOf(info)}
      data-run-mode={runMode ?? ''}
    >
      {spaceCjkLatin(sentence)}
    </p>
  );
}

/** 出处两行：版权、致谢与许可证一句；项目地址一行。 */
function ProjectNotes() {
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p data-testid="settings-version-copyright">
        <Trans
          i18nKey="settings.version.copyrightLine"
          components={{
            upstream: <ExternalLink href={UPSTREAM_URL} testId="settings-version-upstream" />,
            license: <ExternalLink href={LICENSE_URL} testId="settings-version-license" />,
          }}
        />
      </p>
      <p>
        <Trans
          i18nKey="settings.version.projectLine"
          values={{ host: PROJECT_HOST }}
          components={{
            project: <ExternalLink href={PROJECT_URL} testId="settings-version-project" />,
          }}
        />
      </p>
    </div>
  );
}

export function AboutText({
  info,
  deploymentLabel,
  runMode,
}: {
  info?: SystemInfo;
  deploymentLabel: (deployment: SystemInfo['deployment']) => string | null;
  /** mesh 运行模式的展示文案；宿主还没拿到（或查不到）时不传，句子里省掉这一子句。 */
  runMode?: string;
}) {
  return (
    <div className="space-y-4">
      <AboutHeadline info={info} />
      <RuntimeSentence info={info} deploymentLabel={deploymentLabel} runMode={runMode} />
      <ProjectNotes />
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

/** 检查更新的按钮：卡头右侧与标题同一行；检查结论留在内容区。 */
export function UpdateCheckButton({
  isChecking,
  disabled,
  onCheck,
}: {
  isChecking: boolean;
  disabled: boolean;
  onCheck: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      variant="outline"
      size="sm"
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
  );
}

export function UpdateCheckResultRow({ update }: { update: UpdateCheckResult }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <LatestVersionText update={update} />
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
