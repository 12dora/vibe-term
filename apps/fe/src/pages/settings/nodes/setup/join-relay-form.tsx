// 「加入已有中继」表单：等价于 CLI `tmex relay join <relayUrl> --tenant <id>`。
//
// 加入所需的三样东西全部来自中继那侧已经接进去的机器：中继地址、租户编号、mesh 账户密码。
// 中继不认识加入码，也不签发加入码——这条路径没有「先在别处生成一次」的步骤。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import type { LocalStatusResponse, SetupRelayJoinResponse } from '@tmex/api-client/local/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tmex/ui/card';
import { Input } from '@tmex/ui/input';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currentHostname, navigateToLogin } from './browser-location';
import {
  FormField,
  RestartPanel,
  ResultRow,
  SetupNotice,
  SetupSubmitRow,
  SwitchRow,
  directOutcomeLabel,
} from './form-parts';
import { submitJoinRelay } from './submit';
import { useHubSetupSubmit } from './use-hub-setup-submit';
import type { RestartWaiter } from './use-restart-waiter';
import {
  type JoinRelayErrors,
  type JoinRelayValues,
  defaultNodeName,
  hasErrors,
  validateJoinRelay,
} from './validation';

export interface JoinRelayFormProps {
  localStatus: LocalStatusResponse;
  client?: ApiClient;
  /** 默认取地址栏主机名；测试注入。 */
  hostname?: string | null;
  onRestarted?: () => void;
}

export function JoinRelayForm({
  localStatus,
  client = defaultApiClient,
  hostname,
  onRestarted = navigateToLogin,
}: JoinRelayFormProps) {
  const { t } = useTranslation();
  const nodeEnv = localStatus.nodeEnv;
  const directSupported = localStatus.direct.supported;

  const [values, setValues] = useState<JoinRelayValues>(() => ({
    relayUrl: '',
    tenantId: '',
    password: '',
    name: defaultNodeName(hostname === undefined ? currentHostname() : hostname),
    caFingerprint: '',
    directEnable: directSupported,
  }));
  const errors = validateJoinRelay(values, nodeEnv);
  const { showErrors, submitting, submitError, result, waiter, blocked, handleSubmit } =
    useHubSetupSubmit<SetupRelayJoinResponse>({
      client,
      hasErrors: hasErrors(errors),
      uplink: 'relay',
      submit: () => submitJoinRelay(values, client),
      successMessage: t('nodes.setup.toast.relayJoined'),
      onRestarted,
    });
  const shown = showErrors ? errors : {};

  function update(patch: Partial<JoinRelayValues>): void {
    setValues((previous) => ({ ...previous, ...patch }));
  }

  if (result) return <JoinRelayResult result={result} waiter={waiter} />;

  return (
    <Card className="border-0 ring-0" data-testid="setup-join-relay-form">
      <CardHeader>
        <CardTitle>{t('nodes.setup.joinRelay.title')}</CardTitle>
        <CardDescription>{t('nodes.setup.joinRelay.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={(event) => void handleSubmit(event)}>
          <JoinRelayFields values={values} shown={shown} onChange={update} />

          <SwitchRow
            id="setup-relay-join-direct-enable"
            label={t('nodes.setup.fields.directEnable')}
            hint={
              directSupported
                ? t('nodes.setup.fields.directEnableRelayHint')
                : t('nodes.setup.fields.directUnsupportedRelayHint', {
                    platform: localStatus.direct.platform,
                  })
            }
            checked={values.directEnable && directSupported}
            disabled={!directSupported}
            onCheckedChange={(checked) => update({ directEnable: checked })}
          />

          {submitError && (
            <SetupNotice tone="error" testId="setup-join-relay-error">
              {submitError}
            </SetupNotice>
          )}

          <SetupSubmitRow
            testId="setup-join-relay"
            label={t('nodes.setup.submit.joinRelay')}
            submitting={submitting}
            blocked={blocked}
          />
        </form>
      </CardContent>
    </Card>
  );
}

function JoinRelayResult({
  result,
  waiter,
}: {
  result: SetupRelayJoinResponse;
  waiter: RestartWaiter;
}) {
  const { t } = useTranslation();
  return (
    <Card className="border-0 ring-0 tmex-reveal" data-testid="setup-join-relay-result">
      <CardHeader>
        <CardTitle>{t('nodes.setup.result.title')}</CardTitle>
        <CardDescription>{t('nodes.setup.result.relayJoinDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ResultRow label={t('nodes.setup.result.relayUrl')} value={result.relayUrl} />
        <ResultRow label={t('nodes.setup.result.tenantId')} value={result.tenantId} />
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

/** 四个必填字段 + 折叠起来的 CA 指纹。 */
function JoinRelayFields({
  values,
  shown,
  onChange,
}: {
  values: JoinRelayValues;
  shown: JoinRelayErrors;
  onChange: (patch: Partial<JoinRelayValues>) => void;
}) {
  const { t } = useTranslation();
  const [advanced, setAdvanced] = useState(false);
  return (
    <>
      <FormField
        id="setup-relay-url"
        label={t('nodes.setup.fields.relayUrl')}
        hint={t('nodes.setup.fields.relayUrlHint')}
        error={shown.relayUrl && t(shown.relayUrl)}
      >
        <Input
          id="setup-relay-url"
          value={values.relayUrl}
          onChange={(event) => onChange({ relayUrl: event.target.value })}
          placeholder={t('nodes.setup.fields.relayUrlPlaceholder')}
          autoComplete="url"
          className="min-h-10"
        />
      </FormField>

      <FormField
        id="setup-relay-tenant-id"
        label={t('nodes.setup.fields.tenantId')}
        hint={t('nodes.setup.fields.tenantIdHint')}
        error={shown.tenantId && t(shown.tenantId)}
      >
        <Input
          id="setup-relay-tenant-id"
          value={values.tenantId}
          onChange={(event) => onChange({ tenantId: event.target.value })}
          spellCheck={false}
          className="min-h-10 font-mono"
          data-testid="setup-relay-tenant-id-input"
        />
      </FormField>

      <FormField
        id="setup-relay-join-password"
        label={t('nodes.setup.fields.joinPassword')}
        hint={t('nodes.setup.fields.joinPasswordHint')}
        error={shown.password && t(shown.password)}
      >
        <Input
          id="setup-relay-join-password"
          type="password"
          value={values.password}
          onChange={(event) => onChange({ password: event.target.value })}
          autoComplete="current-password"
          className="min-h-10"
          data-testid="setup-relay-join-password-input"
        />
      </FormField>

      <FormField
        id="setup-relay-node-name"
        label={t('nodes.setup.fields.name')}
        hint={t('nodes.setup.fields.nameHint')}
        error={shown.name && t(shown.name)}
      >
        <Input
          id="setup-relay-node-name"
          value={values.name}
          onChange={(event) => onChange({ name: event.target.value })}
          className="min-h-10"
        />
      </FormField>

      <div className="space-y-2">
        <button
          type="button"
          className="text-xs text-primary underline underline-offset-2"
          onClick={() => setAdvanced((previous) => !previous)}
          data-testid="setup-relay-advanced-toggle"
        >
          {t(advanced ? 'nodes.setup.joinRelay.hideAdvanced' : 'nodes.setup.joinRelay.advanced')}
        </button>
        {advanced && (
          <FormField
            id="setup-relay-ca-fingerprint"
            label={t('nodes.setup.fields.caFingerprint')}
            hint={t('nodes.setup.fields.caFingerprintHint')}
            error={shown.caFingerprint && t(shown.caFingerprint)}
          >
            <Input
              id="setup-relay-ca-fingerprint"
              value={values.caFingerprint}
              onChange={(event) => onChange({ caFingerprint: event.target.value })}
              spellCheck={false}
              className="min-h-10 font-mono"
              data-testid="setup-relay-ca-fingerprint-input"
            />
          </FormField>
        )}
      </div>
    </>
  );
}
