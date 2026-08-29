// 「把这台机器变成 hub」表单：创建首个用户 + 写 `TMEX_ROLES=hub,node` + 重启。
//
// 对应 CLI 的 `init --role hub,node` + `hub user add`（见 docs/hub/2026082800-hub-node-operations.md
// 「首次搭 hub」）。HTTPS 由反代 / Cloudflare Tunnel 提供，本批次不内建。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import { SetupApi } from '@tmex/api-client/local/setup-api';
import type {
  LocalStatusResponse,
  SetupHubResponse,
  SetupPrecheckResponse,
} from '@tmex/api-client/local/types';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tmex/ui/card';
import { Input } from '@tmex/ui/input';
import { Loader2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { currentOrigin, navigateToLogin } from './browser-location';
import { describeSetupError } from './error-messages';
import {
  FormField,
  RestartPanel,
  ResultRow,
  SetupNotice,
  SwitchRow,
  directOutcomeLabel,
} from './form-parts';
import { submitBecomeHub } from './submit';
import { useRestartWaiter } from './use-restart-waiter';
import {
  type BecomeHubValues,
  defaultHubPublicUrl,
  hasErrors,
  validateBecomeHub,
} from './validation';

type PrecheckState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'done'; data: SetupPrecheckResponse }
  | { phase: 'error'; message: string };

export interface BecomeHubFormProps {
  localStatus: LocalStatusResponse;
  client?: ApiClient;
  /** 默认取地址栏；测试注入。 */
  origin?: string | null;
  /** 重启完成后的动作，默认整页跳登录页。 */
  onRestarted?: () => void;
}

export function BecomeHubForm({
  localStatus,
  client = defaultApiClient,
  origin,
  onRestarted = navigateToLogin,
}: BecomeHubFormProps) {
  const { t } = useTranslation();
  const nodeEnv = localStatus.nodeEnv;
  const directSupported = localStatus.direct.supported;

  const [values, setValues] = useState<BecomeHubValues>(() => ({
    hubPublicUrl: defaultHubPublicUrl(origin === undefined ? currentOrigin() : origin, nodeEnv),
    username: '',
    password: '',
    confirmPassword: '',
    directEnable: directSupported,
  }));
  const [showErrors, setShowErrors] = useState(false);
  const [precheck, setPrecheck] = useState<PrecheckState>({ phase: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<SetupHubResponse | null>(null);
  const waiter = useRestartWaiter({ client });

  const errors = validateBecomeHub(values, nodeEnv);
  const shown = showErrors ? errors : {};

  useEffect(() => {
    if (waiter.state === 'restarted') onRestarted();
  }, [waiter.state, onRestarted]);

  function update(patch: Partial<BecomeHubValues>): void {
    setValues((previous) => ({ ...previous, ...patch }));
    // 地址一改，上一次 precheck 的结论就作废。
    if (patch.hubPublicUrl !== undefined) setPrecheck({ phase: 'idle' });
  }

  async function runPrecheck(): Promise<void> {
    setShowErrors(true);
    if (errors.hubPublicUrl) return;
    setPrecheck({ phase: 'checking' });
    try {
      const data = await new SetupApi(client).precheck(values.hubPublicUrl.trim());
      setPrecheck({ phase: 'done', data });
    } catch (error) {
      setPrecheck({ phase: 'error', message: describeSetupError(t, error) });
    }
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setShowErrors(true);
    if (hasErrors(errors)) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const outcome = await submitBecomeHub(values, client);
      setResult(outcome.result);
      toast.success(t('nodes.setup.toast.hubCreated'));
      waiter.start(outcome.previousStartedAt);
    } catch (error) {
      const message = describeSetupError(t, error);
      setSubmitError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <Card className="border-0 ring-0 tmex-reveal" data-testid="setup-become-hub-result">
        <CardHeader>
          <CardTitle>{t('nodes.setup.result.title')}</CardTitle>
          <CardDescription>{t('nodes.setup.result.becomeHubDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ResultRow label={t('nodes.setup.result.fingerprint')} value={result.fingerprint} />
          <ResultRow
            label={t('nodes.setup.result.hubPublicUrl')}
            value={values.hubPublicUrl.trim()}
          />
          <ResultRow label={t('nodes.setup.result.username')} value={values.username.trim()} />
          <ResultRow
            label={t('nodes.setup.result.directLabel')}
            value={directOutcomeLabel(t, result.direct, result.directError)}
          />
          <RestartPanel waiter={waiter} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-0 ring-0" data-testid="setup-become-hub-form">
      <CardHeader>
        <CardTitle>{t('nodes.setup.becomeHub.title')}</CardTitle>
        <CardDescription>{t('nodes.setup.becomeHub.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={(event) => void handleSubmit(event)}>
          <FormField
            id="setup-hub-public-url"
            label={t('nodes.setup.fields.hubPublicUrl')}
            hint={t('nodes.setup.fields.hubPublicUrlHint')}
            error={shown.hubPublicUrl && t(shown.hubPublicUrl)}
          >
            <Input
              id="setup-hub-public-url"
              value={values.hubPublicUrl}
              onChange={(event) => update({ hubPublicUrl: event.target.value })}
              placeholder="https://tmex.example.com"
              autoComplete="url"
              className="min-h-10"
            />
          </FormField>

          <div className="space-y-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void runPrecheck()}
              disabled={precheck.phase === 'checking'}
              data-testid="setup-precheck-button"
            >
              {precheck.phase === 'checking' && <Loader2 className="animate-spin" />}
              {t('nodes.setup.precheck.button')}
            </Button>
            <PrecheckResult state={precheck} />
          </div>

          <FormField
            id="setup-username"
            label={t('nodes.setup.fields.username')}
            hint={t('nodes.setup.fields.usernameHint')}
            error={shown.username && t(shown.username)}
          >
            <Input
              id="setup-username"
              value={values.username}
              onChange={(event) => update({ username: event.target.value })}
              autoComplete="username"
              className="min-h-10"
            />
          </FormField>

          <FormField
            id="setup-password"
            label={t('nodes.setup.fields.password')}
            hint={t('nodes.setup.fields.passwordHint')}
            error={shown.password && t(shown.password)}
          >
            <Input
              id="setup-password"
              type="password"
              value={values.password}
              onChange={(event) => update({ password: event.target.value })}
              autoComplete="new-password"
              className="min-h-10"
            />
          </FormField>

          <FormField
            id="setup-confirm-password"
            label={t('nodes.setup.fields.confirmPassword')}
            error={shown.confirmPassword && t(shown.confirmPassword)}
          >
            <Input
              id="setup-confirm-password"
              type="password"
              value={values.confirmPassword}
              onChange={(event) => update({ confirmPassword: event.target.value })}
              autoComplete="new-password"
              className="min-h-10"
            />
          </FormField>

          <SwitchRow
            id="setup-direct-enable"
            label={t('nodes.setup.fields.directEnable')}
            hint={
              directSupported
                ? t('nodes.setup.fields.directEnableHint')
                : t('nodes.setup.fields.directUnsupportedHint', {
                    platform: localStatus.direct.platform,
                  })
            }
            checked={values.directEnable && directSupported}
            disabled={!directSupported}
            onCheckedChange={(checked) => update({ directEnable: checked })}
          />

          {submitError && (
            <SetupNotice tone="error" testId="setup-become-hub-error">
              {submitError}
            </SetupNotice>
          )}

          <Button type="submit" disabled={submitting} data-testid="setup-become-hub-submit">
            {submitting && <Loader2 className="animate-spin" />}
            {submitting ? t('nodes.setup.submit.pending') : t('nodes.setup.submit.becomeHub')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PrecheckResult({ state }: { state: PrecheckState }) {
  const { t } = useTranslation();
  if (state.phase === 'idle' || state.phase === 'checking') return null;

  if (state.phase === 'error') {
    return (
      <SetupNotice tone="error" testId="setup-precheck-error">
        {state.message}
      </SetupNotice>
    );
  }

  const { reachable, isSelf, status, error } = state.data;

  if (reachable && isSelf) {
    return (
      <SetupNotice tone="success" testId="setup-precheck-self">
        {t('nodes.setup.precheck.reachableSelf')}
      </SetupNotice>
    );
  }

  if (reachable) {
    return (
      <SetupNotice tone="warning" testId="setup-precheck-other">
        {t('nodes.setup.precheck.reachableOther', { status: status ?? '' })}
      </SetupNotice>
    );
  }

  return (
    <SetupNotice tone="error" testId="setup-precheck-unreachable">
      <p>{t('nodes.setup.precheck.unreachable', { error: error ?? '' })}</p>
      <p>{t('nodes.setup.precheck.httpsHint')}</p>
    </SetupNotice>
  );
}
