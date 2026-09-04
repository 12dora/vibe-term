// 「加入已有 Hub」表单：默认用 mesh 账户密码加入（等价于 CLI `hub join <hubUrl> --password`），
// 也可以切回加入码（`--token`，见 docs/hub/2026082800-hub-node-operations.md「4. 各机加入」）。
//
// 加入码由 hub 侧 `tmex-cli enroll` 或任意已登录入口的节点页签发，默认 10 分钟有效；
// 密码路径不需要任何人在 Hub 上先操作一次，因此作为默认。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import type { LocalStatusResponse, SetupJoinResponse } from '@tmex/api-client/local/types';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tmex/ui/card';
import { Input } from '@tmex/ui/input';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currentHostname, navigateToLogin } from './browser-location';
import {
  FormField,
  RestartPanel,
  ResultRow,
  SetupNotice,
  SwitchRow,
  directOutcomeLabel,
} from './form-parts';
import { submitJoinHub } from './submit';
import { useHubSetupSubmit } from './use-hub-setup-submit';
import {
  type JoinHubErrors,
  type JoinHubValues,
  type JoinMethod,
  defaultNodeName,
  hasErrors,
  validateJoinHub,
} from './validation';

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
    method: 'password',
    hubUrl: '',
    token: '',
    password: '',
    name: defaultNodeName(hostname === undefined ? currentHostname() : hostname),
    directEnable: directSupported,
    insecureLocal: false,
  }));
  const errors = validateJoinHub(values, nodeEnv);
  const { showErrors, submitting, submitError, result, waiter, handleSubmit } =
    useHubSetupSubmit<SetupJoinResponse>({
      client,
      hasErrors: hasErrors(errors),
      submit: () => submitJoinHub(values, nodeEnv, client),
      successMessage: t('nodes.setup.toast.joined'),
      onRestarted,
    });
  const shown = showErrors ? errors : {};

  function update(patch: Partial<JoinHubValues>): void {
    setValues((previous) => ({ ...previous, ...patch }));
  }

  if (result) {
    return (
      <Card className="border-0 ring-0 tmex-reveal" data-testid="setup-join-hub-result">
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
        <CardDescription>
          {t(
            values.method === 'password'
              ? 'nodes.setup.joinHub.passwordDescription'
              : 'nodes.setup.joinHub.description'
          )}
        </CardDescription>
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
              placeholder={t('nodes.setup.fields.urlPlaceholder')}
              autoComplete="url"
              className="min-h-10"
            />
          </FormField>

          <JoinCredentialField
            values={values}
            shown={shown}
            onChange={update}
            onSwitch={(method) => update({ method })}
          />

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

/** 凭据这一格：密码与加入码互斥，切换按钮跟在字段下方。 */
function JoinCredentialField({
  values,
  shown,
  onChange,
  onSwitch,
}: {
  values: JoinHubValues;
  shown: JoinHubErrors;
  onChange: (patch: Partial<JoinHubValues>) => void;
  onSwitch: (method: JoinMethod) => void;
}) {
  const { t } = useTranslation();
  if (values.method === 'password') {
    return (
      <div className="space-y-2">
        <FormField
          id="setup-join-password"
          label={t('nodes.setup.fields.joinPassword')}
          hint={t('nodes.setup.fields.joinPasswordHint')}
          error={shown.password && t(shown.password)}
        >
          <Input
            id="setup-join-password"
            type="password"
            value={values.password}
            onChange={(event) => onChange({ password: event.target.value })}
            autoComplete="current-password"
            className="min-h-10"
            data-testid="setup-join-password-input"
          />
        </FormField>
        <MethodSwitch
          testId="setup-join-method-token"
          label={t('nodes.setup.joinHub.useToken')}
          onClick={() => onSwitch('token')}
        />
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <FormField
        id="setup-join-token"
        label={t('nodes.setup.fields.token')}
        hint={t('nodes.setup.fields.tokenHint')}
        error={shown.token && t(shown.token)}
      >
        <textarea
          id="setup-join-token"
          value={values.token}
          onChange={(event) => onChange({ token: event.target.value })}
          rows={3}
          spellCheck={false}
          placeholder={t('nodes.setup.fields.tokenPlaceholder')}
          className="w-full resize-y rounded-md bg-muted/40 p-2 font-mono text-xs outline-none ring-1 ring-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="setup-join-token-input"
        />
      </FormField>
      <MethodSwitch
        testId="setup-join-method-password"
        label={t('nodes.setup.joinHub.usePassword')}
        onClick={() => onSwitch('password')}
      />
    </div>
  );
}

function MethodSwitch({
  testId,
  label,
  onClick,
}: {
  testId: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="text-xs text-primary underline underline-offset-2"
      onClick={onClick}
      data-testid={testId}
    >
      {label}
    </button>
  );
}
