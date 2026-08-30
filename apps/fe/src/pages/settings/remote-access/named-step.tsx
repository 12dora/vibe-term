// 命名隧道：登录 Cloudflare → 填主机名 → 创建并启动。
//
// 登录是后台 job：`login` 受理后 `auth.loginUrl` 才会出现，用户在别的标签页完成授权，
// 这边靠轮询看到 `auth.loggedIn` 翻真。授权页有有效期，超时由后端报 `login_timeout`。

import type { TunnelStatusResponse } from '@tmex/shared';
import { Button, buttonVariants } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { ExternalLink, Loader2, LogIn, Rocket } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { CopyButton } from '../nodes/copy-feedback';
import { FormField, SetupNotice } from '../nodes/setup/form-parts';
import { JobProgress, ProgressRow } from './step-shell';
import type { TunnelActions } from './tunnel-actions';
import { describeTunnelError, isValidHostname } from './tunnel-model';

export function NamedTunnelStep({
  status,
  actions,
  isHub,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  isHub: boolean;
}) {
  const { t } = useTranslation();
  const job = status.job;
  const loginRunning = job?.kind === 'login' && job.state === 'running';
  const loginFailed = job?.kind === 'login' && job.state === 'error' && job.error !== null;

  if (!status.auth.loggedIn) {
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

  return <CreateTunnelForm status={status} actions={actions} isHub={isHub} />;
}

function CreateTunnelForm({
  status,
  actions,
  isHub,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  isHub: boolean;
}) {
  const { t } = useTranslation();
  const [hostname, setHostname] = useState(status.config.hostname ?? '');
  const [tunnelName, setTunnelName] = useState(status.config.tunnelName ?? '');
  const [touched, setTouched] = useState(false);
  const job = status.job;
  const creating = job?.kind === 'create' && job.state === 'running';
  const createFailed = job?.kind === 'create' && job.state === 'error' && job.error !== null;
  const trimmed = hostname.trim();
  const invalid = !isValidHostname(trimmed);

  const submit = () => {
    setTouched(true);
    if (invalid || actions.busy) return;
    const name = tunnelName.trim();
    actions.run(
      name
        ? { action: 'create', hostname: trimmed, tunnelName: name }
        : { action: 'create', hostname: trimmed }
    );
  };

  return (
    <div className="space-y-3" data-testid="remote-access-create">
      <SetupNotice tone="success" testId="remote-access-logged-in">
        {t('settings.remoteAccess.steps.named.login.done')}
      </SetupNotice>

      {createFailed && job.error && (
        <SetupNotice tone="error" testId="remote-access-create-error">
          {describeTunnelError(t, job.error)}
        </SetupNotice>
      )}

      <FormField
        id="remote-access-hostname"
        label={t('settings.remoteAccess.steps.named.hostname')}
        hint={t('settings.remoteAccess.steps.named.hostnameHint')}
        {...(touched && invalid
          ? { error: t('settings.remoteAccess.steps.named.hostnameInvalid') }
          : {})}
      >
        <Input
          id="remote-access-hostname"
          data-testid="remote-access-hostname"
          value={hostname}
          disabled={actions.busy}
          placeholder={t('settings.remoteAccess.steps.named.hostnamePlaceholder')}
          onChange={(event) => setHostname(event.target.value)}
          onBlur={() => setTouched(true)}
        />
      </FormField>

      {isHub && (
        <p className="text-xs text-muted-foreground" data-testid="remote-access-hub-hint">
          {t('settings.remoteAccess.steps.named.hubHint')}{' '}
          <Link className="text-primary underline-offset-4 hover:underline" to="?tab=nodes">
            {t('settings.remoteAccess.steps.named.hubHintLink')}
          </Link>
        </p>
      )}

      <FormField
        id="remote-access-tunnel-name"
        label={t('settings.remoteAccess.steps.named.tunnelName')}
        hint={t('settings.remoteAccess.steps.named.tunnelNameHint')}
      >
        <Input
          id="remote-access-tunnel-name"
          data-testid="remote-access-tunnel-name"
          value={tunnelName}
          disabled={actions.busy}
          placeholder={t('settings.remoteAccess.steps.named.tunnelNamePlaceholder')}
          onChange={(event) => setTunnelName(event.target.value)}
        />
      </FormField>

      {creating && <JobProgress step={job.step} testId="remote-access-create-progress" />}

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={actions.busy}
          onClick={submit}
          data-testid="remote-access-create-submit"
        >
          {actions.pending === 'create' ? <Loader2 className="animate-spin" /> : <Rocket />}
          {t('settings.remoteAccess.actions.create')}
        </Button>
      </div>
    </div>
  );
}
