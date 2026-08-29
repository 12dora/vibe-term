// 「加入已有 hub」表单：等价于 CLI `hub join <hubUrl> --token <token> --name <name>`
//（见 docs/hub/2026082800-hub-node-operations.md「4. 各机加入」）。
//
// join 串由 hub 侧 `tmex-cli enroll` 或任意已登录入口的 Nodes 页签发，默认 10 分钟有效。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import type { LocalStatusResponse, SetupJoinResponse } from '@tmex/api-client/local/types';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tmex/ui/card';
import { Input } from '@tmex/ui/input';
import { Loader2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { currentHostname, navigateToLogin } from './browser-location';
import { describeSetupError } from './error-messages';
import {
  FormField,
  RestartPanel,
  ResultRow,
  SetupNotice,
  SwitchRow,
  directOutcomeLabel,
} from './form-parts';
import { submitJoinHub } from './submit';
import { useRestartWaiter } from './use-restart-waiter';
import { type JoinHubValues, defaultNodeName, hasErrors, validateJoinHub } from './validation';

export interface JoinHubFormProps {
  localStatus: LocalStatusResponse;
  client?: ApiClient;
  /** 默认取地址栏主机名；测试注入。 */
  hostname?: string | null;
  onRestarted?: () => void;
}

export function JoinHubForm({
  localStatus,
  client = defaultApiClient,
  hostname,
  onRestarted = navigateToLogin,
}: JoinHubFormProps) {
  const { t } = useTranslation();
  const nodeEnv = localStatus.nodeEnv;
  const directSupported = localStatus.direct.supported;
  // `insecureLocal` 只在非 production 有意义：后端在 production 下一律忽略。
  const allowInsecureLocal = nodeEnv !== 'production';

  const [values, setValues] = useState<JoinHubValues>(() => ({
    hubUrl: '',
    token: '',
    name: defaultNodeName(hostname === undefined ? currentHostname() : hostname),
    directEnable: directSupported,
    insecureLocal: false,
  }));
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<SetupJoinResponse | null>(null);
  const waiter = useRestartWaiter({ client });

  const errors = validateJoinHub(values, nodeEnv);
  const shown = showErrors ? errors : {};

  useEffect(() => {
    if (waiter.state === 'restarted') onRestarted();
  }, [waiter.state, onRestarted]);

  function update(patch: Partial<JoinHubValues>): void {
    setValues((previous) => ({ ...previous, ...patch }));
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setShowErrors(true);
    if (hasErrors(errors)) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const outcome = await submitJoinHub(values, nodeEnv, client);
      setResult(outcome.result);
      toast.success(t('nodes.setup.toast.joined'));
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
      <Card className="border-0 ring-0" data-testid="setup-join-hub-result">
        <CardHeader>
          <CardTitle>{t('nodes.setup.result.title')}</CardTitle>
          <CardDescription>{t('nodes.setup.result.joinDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ResultRow label={t('nodes.setup.result.hubUrl')} value={result.hubUrl} />
          <ResultRow label={t('nodes.setup.result.username')} value={result.username} />
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
    <Card className="border-0 ring-0" data-testid="setup-join-hub-form">
      <CardHeader>
        <CardTitle>{t('nodes.setup.joinHub.title')}</CardTitle>
        <CardDescription>{t('nodes.setup.joinHub.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={(event) => void handleSubmit(event)}>
          <FormField
            id="setup-hub-url"
            label={t('nodes.setup.fields.hubUrl')}
            hint={t('nodes.setup.fields.hubUrlHint')}
            error={shown.hubUrl && t(shown.hubUrl)}
          >
            <Input
              id="setup-hub-url"
              value={values.hubUrl}
              onChange={(event) => update({ hubUrl: event.target.value })}
              placeholder="https://tmex.example.com"
              autoComplete="url"
              className="min-h-10"
            />
          </FormField>

          <FormField
            id="setup-join-token"
            label={t('nodes.setup.fields.token')}
            hint={t('nodes.setup.fields.tokenHint')}
            error={shown.token && t(shown.token)}
          >
            <textarea
              id="setup-join-token"
              value={values.token}
              onChange={(event) => update({ token: event.target.value })}
              rows={3}
              spellCheck={false}
              placeholder={t('nodes.setup.fields.tokenPlaceholder')}
              className="w-full resize-y rounded-md bg-muted/40 p-2 font-mono text-xs outline-none ring-1 ring-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="setup-join-token-input"
            />
          </FormField>

          <FormField
            id="setup-node-name"
            label={t('nodes.setup.fields.name')}
            hint={t('nodes.setup.fields.nameHint')}
            error={shown.name && t(shown.name)}
          >
            <Input
              id="setup-node-name"
              value={values.name}
              onChange={(event) => update({ name: event.target.value })}
              className="min-h-10"
            />
          </FormField>

          <SwitchRow
            id="setup-join-direct-enable"
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

          {allowInsecureLocal && (
            <SwitchRow
              id="setup-insecure-local"
              label={t('nodes.setup.fields.insecureLocal')}
              hint={t('nodes.setup.fields.insecureLocalHint')}
              checked={values.insecureLocal}
              onCheckedChange={(checked) => update({ insecureLocal: checked })}
            />
          )}

          {submitError && (
            <SetupNotice tone="error" testId="setup-join-hub-error">
              {submitError}
            </SetupNotice>
          )}

          <Button type="submit" disabled={submitting} data-testid="setup-join-hub-submit">
            {submitting && <Loader2 className="animate-spin" />}
            {submitting ? t('nodes.setup.submit.pending') : t('nodes.setup.submit.joinHub')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
