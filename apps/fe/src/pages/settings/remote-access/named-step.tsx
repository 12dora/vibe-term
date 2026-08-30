// 命名隧道的三步：登录 Cloudflare → 主机名 → 创建并启动。
//
// 登录是后台 job：`login` 受理后 `auth.loginUrl` 才会出现，用户在别的标签页完成授权，
// 这边靠轮询看到 `auth.loggedIn` 翻真。授权页有有效期，超时由后端报 `login_timeout`。
//
// 主机名没有单独的保存动作（契约里只有 `create` 带 hostname），所以「确认」只是向导内部的
// 一步：确认之后才展开创建，Access 那一步也才有可展示的目标主机名。

import type { TunnelStatusResponse } from '@tmex/shared';
import { Button, buttonVariants } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { ArrowRight, ExternalLink, Loader2, LogIn, Pencil, Rocket } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { CopyButton } from '../nodes/copy-feedback';
import { FormField, SetupNotice } from '../nodes/setup/form-parts';
import { type ExposureState, ExposureWarning } from './exposure';
import { DetailRow, JobProgress, ProgressRow } from './step-shell';
import type { TunnelActions } from './tunnel-actions';
import { describeTunnelError, isValidHostname, isValidTunnelName } from './tunnel-model';

/** 主机名 / 隧道名称的草稿，由向导持有：创建那一步要用同一份。 */
export interface NamedDraft {
  hostname: string;
  tunnelName: string;
  confirmed: boolean;
  setHostname: (value: string) => void;
  setTunnelName: (value: string) => void;
  setConfirmed: (value: boolean) => void;
}

export function LoginStep({
  status,
  actions,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
}) {
  const { t } = useTranslation();
  const job = status.job;
  const loginRunning = job?.kind === 'login' && job.state === 'running';
  const loginFailed = job?.kind === 'login' && job.state === 'error' && job.error !== null;

  if (status.config.externallyManaged) {
    return (
      <SetupNotice tone="info" testId="remote-access-login-skipped">
        {t('settings.remoteAccess.steps.login.skipped')}
      </SetupNotice>
    );
  }

  if (status.auth.loggedIn) {
    return (
      <SetupNotice tone="success" testId="remote-access-logged-in">
        {t('settings.remoteAccess.steps.named.login.done')}
      </SetupNotice>
    );
  }

  return (
    <div className="space-y-2" data-testid="remote-access-login">
      <p className="text-xs text-muted-foreground">
        {t('settings.remoteAccess.steps.named.login.description')}
      </p>

      {loginFailed && job.error && (
        <SetupNotice tone="error" testId="remote-access-login-error">
          {describeTunnelError(t, job.error)}
        </SetupNotice>
      )}

      {loginRunning ? (
        <div className="space-y-2">
          <ProgressRow
            label={t('settings.remoteAccess.steps.named.login.waiting')}
            testId="remote-access-login-waiting"
          />
          {status.auth.loginUrl && (
            <div className="flex flex-wrap items-center gap-1.5">
              <a
                className={buttonVariants({ size: 'sm' })}
                href={status.auth.loginUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="remote-access-login-url"
              >
                <ExternalLink />
                {t('settings.remoteAccess.actions.openLoginUrl')}
              </a>
              <CopyButton value={status.auth.loginUrl} testId="remote-access-login-url" />
            </div>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={actions.pending !== null}
            onClick={() => actions.run({ action: 'cancel_login' })}
            data-testid="remote-access-login-cancel"
          >
            {actions.pending === 'cancel_login' ? <Loader2 className="animate-spin" /> : null}
            {t('settings.remoteAccess.actions.cancelLogin')}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          disabled={actions.busy}
          onClick={() => actions.run({ action: 'login' })}
          data-testid="remote-access-login-start"
        >
          {actions.pending === 'login' ? <Loader2 className="animate-spin" /> : <LogIn />}
          {t('settings.remoteAccess.actions.login')}
        </Button>
      )}
    </div>
  );
}

export function HostnameStep({
  status,
  actions,
  draft,
  isHub,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  draft: NamedDraft;
  isHub: boolean;
}) {
  const { t } = useTranslation();

  // 隧道已经建好：换主机名必须先移除，这里只留只读摘要。
  if (status.config.mode === 'named') {
    return (
      <div className="space-y-2" data-testid="remote-access-named-summary">
        <div className="space-y-0.5">
          <DetailRow
            label={t('settings.remoteAccess.steps.named.hostname')}
            testId="remote-access-named-hostname"
          >
            <span className="font-mono">{status.config.hostname ?? '—'}</span>
          </DetailRow>
          <DetailRow
            label={t('settings.remoteAccess.steps.named.tunnelName')}
            testId="remote-access-named-name"
          >
            <span className="font-mono">{status.config.tunnelName ?? '—'}</span>
          </DetailRow>
        </div>
        <HubHint isHub={isHub} />
        <p className="text-xs text-muted-foreground">
          {t('settings.remoteAccess.steps.named.changeHint')}
        </p>
      </div>
    );
  }

  if (!status.auth.loggedIn) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="remote-access-hostname-pending">
        {t('settings.remoteAccess.steps.hostname.pending')}
      </p>
    );
  }

  const trimmed = draft.hostname.trim();
  const hostnameInvalid = trimmed.length > 0 && !isValidHostname(trimmed);
  const name = draft.tunnelName.trim();
  // 名称留空时由后端生成；填了就必须过与后端一致的字符集校验（凭证文件名直接由它拼出来）。
  const nameInvalid = name.length > 0 && !isValidTunnelName(name);

  if (draft.confirmed) {
    return (
      <div className="space-y-2" data-testid="remote-access-hostname-confirmed">
        <div className="space-y-0.5">
          <DetailRow label={t('settings.remoteAccess.steps.named.hostname')}>
            <span className="font-mono">{trimmed}</span>
          </DetailRow>
          {name && (
            <DetailRow label={t('settings.remoteAccess.steps.named.tunnelName')}>
              <span className="font-mono">{name}</span>
            </DetailRow>
          )}
        </div>
        <HubHint isHub={isHub} />
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={actions.busy}
          onClick={() => draft.setConfirmed(false)}
          data-testid="remote-access-hostname-edit"
        >
          <Pencil />
          {t('settings.remoteAccess.steps.hostname.edit')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="remote-access-hostname-form">
      <FormField
        id="remote-access-hostname"
        label={t('settings.remoteAccess.steps.named.hostname')}
        hint={t('settings.remoteAccess.steps.named.hostnameHint')}
        {...(hostnameInvalid
          ? { error: t('settings.remoteAccess.steps.named.hostnameInvalid') }
          : {})}
      >
        <Input
          id="remote-access-hostname"
          data-testid="remote-access-hostname"
          value={draft.hostname}
          disabled={actions.busy}
          placeholder={t('settings.remoteAccess.steps.named.hostnamePlaceholder')}
          onChange={(event) => draft.setHostname(event.target.value)}
        />
      </FormField>

      <HubHint isHub={isHub} />

      <FormField
        id="remote-access-tunnel-name"
        label={t('settings.remoteAccess.steps.named.tunnelName')}
        hint={t('settings.remoteAccess.steps.named.tunnelNameHint')}
        {...(nameInvalid
          ? { error: t('settings.remoteAccess.steps.named.tunnelNameInvalid') }
          : {})}
      >
        <Input
          id="remote-access-tunnel-name"
          data-testid="remote-access-tunnel-name"
          value={draft.tunnelName}
          disabled={actions.busy}
          placeholder={t('settings.remoteAccess.steps.named.tunnelNamePlaceholder')}
          onChange={(event) => draft.setTunnelName(event.target.value)}
        />
      </FormField>

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={actions.busy || !isValidHostname(trimmed) || nameInvalid}
          onClick={() => draft.setConfirmed(true)}
          data-testid="remote-access-hostname-confirm"
        >
          <ArrowRight />
          {t('settings.remoteAccess.steps.hostname.confirm')}
        </Button>
      </div>
    </div>
  );
}

export function CreateStep({
  status,
  actions,
  draft,
  isHub,
  exposure,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  draft: NamedDraft;
  isHub: boolean;
  exposure: ExposureState;
}) {
  const { t } = useTranslation();
  const job = status.job;

  if (status.config.mode === 'named') {
    return (
      <div className="space-y-2" data-testid="remote-access-named-created">
        <SetupNotice tone="success" testId="remote-access-named-configured">
          {t(
            status.config.externallyManaged
              ? 'settings.remoteAccess.steps.create.adopted'
              : 'settings.remoteAccess.steps.named.configured'
          )}
        </SetupNotice>
        <DetailRow
          label={t('settings.remoteAccess.steps.named.tunnelId')}
          testId="remote-access-named-id"
        >
          <span className="font-mono">{status.config.tunnelId ?? '—'}</span>
        </DetailRow>
        <HubHint isHub={isHub} />
      </div>
    );
  }

  if (!draft.confirmed) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="remote-access-create-pending">
        {t('settings.remoteAccess.steps.create.pending')}
      </p>
    );
  }

  const creating = job?.kind === 'create' && job.state === 'running';
  const createFailed = job?.kind === 'create' && job.state === 'error' && job.error !== null;
  const hostname = draft.hostname.trim();
  const name = draft.tunnelName.trim();

  return (
    <div className="space-y-3" data-testid="remote-access-create">
      {createFailed && job.error && job.error.code !== 'exposure_ack_required' && (
        <SetupNotice tone="error" testId="remote-access-create-error">
          {describeTunnelError(t, job.error)}
        </SetupNotice>
      )}

      <ExposureWarning
        exposure={exposure}
        id="remote-access-create-ack"
        testId="remote-access-create-exposure"
        variant="compact"
      />

      {creating && <JobProgress step={job.step} testId="remote-access-create-progress" />}

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={actions.busy}
          onClick={() =>
            actions.run(
              name
                ? { action: 'create', hostname, tunnelName: name }
                : { action: 'create', hostname }
            )
          }
          data-testid="remote-access-create-submit"
        >
          {actions.pending === 'create' ? <Loader2 className="animate-spin" /> : <Rocket />}
          {t('settings.remoteAccess.actions.create')}
        </Button>
      </div>
    </div>
  );
}

/** 本机即 Hub 时，创建出来的主机名同样要写进 Hub 公开地址，否则 join 串仍指向内网。 */
function HubHint({ isHub }: { isHub: boolean }) {
  const { t } = useTranslation();
  if (!isHub) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="remote-access-hub-hint">
      {t('settings.remoteAccess.steps.named.hubHint')}{' '}
      <Link className="text-primary underline-offset-4 hover:underline" to="?tab=nodes">
        {t('settings.remoteAccess.steps.named.hubHintLink')}
      </Link>
    </p>
  );
}
