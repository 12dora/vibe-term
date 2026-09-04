// 「本机作为中继」表单：写 `TMEX_ROLES=relay[,node]` + 中继公网地址 + 接入口令，然后重启。
//
// 两档角色的差别很大：`relay,node` 本机仍有账号与网页，重启后跳登录页；纯 `relay` 重启后
// 网页整个消失，只剩 `tmex relay` 命令，因此那一档提交完不等重启（等不到网页回来）。

import { PasswordFieldWithGenerate } from '@/components/forms/password-field-with-generate';
import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import type {
  LocalStatusResponse,
  SetupRelayResponse,
  SetupRelayRole,
} from '@tmex/api-client/local/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tmex/ui/card';
import { Input } from '@tmex/ui/input';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type BecomeRelayGateEvent,
  becomeRelayGate,
  pureRelaySubmitPlan,
} from './become-relay-gate';
import { currentOrigin, navigateToLogin } from './browser-location';
import {
  FormField,
  RestartPanel,
  ResultRow,
  SetupNotice,
  SetupSubmitRow,
  SwitchRow,
} from './form-parts';
import { PureRelayConfirm } from './pure-relay-confirm';
import { writeSelfRelayFollowUp } from './self-relay-followup';
import { submitBecomeRelay } from './submit';
import { useHubSetupSubmit } from './use-hub-setup-submit';
import type { RestartWaiter } from './use-restart-waiter';
import {
  type BecomeRelayValues,
  defaultRelayPublicUrl,
  hasErrors,
  validateBecomeRelay,
} from './validation';

export interface BecomeRelayFormProps {
  localStatus: LocalStatusResponse;
  client?: ApiClient;
  /** 默认取地址栏；测试注入。 */
  origin?: string | null;
  /** 预选角色：角色下拉与跨重启记号都会带过来，默认中继兼节点。 */
  initialRole?: SetupRelayRole;
  /** 重启完成后的动作，默认整页跳登录页。 */
  onRestarted?: () => void;
}

function initialValues(input: {
  origin?: string | null;
  nodeEnv: LocalStatusResponse['nodeEnv'];
  initialRole: SetupRelayRole;
  directSupported: boolean;
}): BecomeRelayValues {
  const origin = input.origin === undefined ? currentOrigin() : input.origin;
  return {
    relayPublicUrl: defaultRelayPublicUrl(origin, input.nodeEnv),
    relayPassword: '',
    alsoNode: input.initialRole === 'relay,node',
    username: '',
    password: '',
    confirmPassword: '',
    directEnable: input.directSupported,
  };
}

export function BecomeRelayForm({
  localStatus,
  client = defaultApiClient,
  origin,
  initialRole = 'relay,node',
  onRestarted = navigateToLogin,
}: BecomeRelayFormProps) {
  const { t } = useTranslation();
  const nodeEnv = localStatus.nodeEnv;
  const directSupported = localStatus.direct.supported;

  const [values, setValues] = useState<BecomeRelayValues>(() =>
    initialValues({ origin, nodeEnv, initialRole, directSupported })
  );

  // 纯中继一提交就没有网页可回，也无法在网页里改回来：这一档必须先确认。
  const [confirmingPure, setConfirmingPure] = useState(false);

  const errors = validateBecomeRelay(values, nodeEnv);
  const {
    showErrors,
    revealErrors,
    submitting,
    submitError,
    result,
    waiter,
    blocked,
    handleSubmit,
  } = useHubSetupSubmit<SetupRelayResponse>({
    client,
    hasErrors: hasErrors(errors),
    uplink: 'relay',
    submit: async () => {
      const outcome = await submitBecomeRelay(values, client);
      // 中继起来之后本机还要以租户身份接一次自己的中继：留个记号，重启后把入口顶到眼前。
      if (values.alsoNode) writeSelfRelayFollowUp();
      return outcome;
    },
    successMessage: t('nodes.setup.toast.relayCreated'),
    onRestarted,
    waitForRestart: values.alsoNode,
  });
  const shown = showErrors ? errors : {};

  function update(patch: Partial<BecomeRelayValues>): void {
    setValues((previous) => ({ ...previous, ...patch }));
  }

  /** 闸门说提交就提交；说确认就先开确认框（`becomeRelayGate`）。 */
  function step(event: BecomeRelayGateEvent, formEvent?: FormEvent): void {
    const next = becomeRelayGate(event);
    setConfirmingPure(next.confirming);
    if (!next.submit) return;
    // 确认框里点「创建并重启」时没有真实表单事件，补一个空的。
    void handleSubmit(formEvent ?? ({ preventDefault: () => undefined } as FormEvent));
  }

  if (result) return <BecomeRelayResult result={result} waiter={waiter} />;

  return (
    <Card className="border-0 ring-0" data-testid="setup-become-relay-form">
      <CardHeader>
        <CardTitle>{t('nodes.setup.becomeRelay.title')}</CardTitle>
        <CardDescription>{t('nodes.setup.becomeRelay.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            revealErrors();
            step({ kind: 'submit', plan: pureRelaySubmitPlan(values, nodeEnv) }, event);
          }}
        >
          <RelayServiceFields values={values} shown={shown} onChange={update} />

          {values.alsoNode ? (
            <RelayAccountFields
              values={values}
              shown={shown}
              directSupported={directSupported}
              platform={localStatus.direct.platform}
              onChange={update}
            />
          ) : (
            <SetupNotice tone="warning" testId="setup-relay-pure-notice">
              {t('nodes.setup.becomeRelay.pureNotice')}
            </SetupNotice>
          )}

          {submitError && (
            <SetupNotice tone="error" testId="setup-become-relay-error">
              {submitError}
            </SetupNotice>
          )}

          <SetupSubmitRow
            testId="setup-become-relay"
            label={t('nodes.setup.submit.becomeRelay')}
            submitting={submitting}
            blocked={blocked}
          />
        </form>
      </CardContent>

      <PureRelayConfirm
        open={confirmingPure}
        onConfirm={() => step({ kind: 'confirm' })}
        onCancel={() => step({ kind: 'cancel' })}
      />
    </Card>
  );
}

/** 中继服务本身的三项：对外地址、接入口令、要不要同时当节点。 */
function RelayServiceFields({
  values,
  shown,
  onChange,
}: {
  values: BecomeRelayValues;
  shown: Partial<Record<string, string>>;
  onChange: (patch: Partial<BecomeRelayValues>) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <FormField
        id="setup-relay-public-url"
        label={t('nodes.setup.fields.relayPublicUrl')}
        hint={t('nodes.setup.fields.relayPublicUrlHint')}
        error={shown.relayPublicUrl && t(shown.relayPublicUrl)}
      >
        <Input
          id="setup-relay-public-url"
          value={values.relayPublicUrl}
          onChange={(event) => onChange({ relayPublicUrl: event.target.value })}
          placeholder={t('nodes.setup.fields.urlPlaceholder')}
          autoComplete="url"
          className="min-h-10"
        />
      </FormField>

      <FormField
        id="setup-relay-password"
        label={t('nodes.setup.fields.relayPassword')}
        hint={t('nodes.setup.fields.relayPasswordHint')}
        error={shown.relayPassword && t(shown.relayPassword)}
      >
        <PasswordFieldWithGenerate
          id="setup-relay-password"
          value={values.relayPassword}
          onChange={(next) => onChange({ relayPassword: next })}
          defaultGenerate
        />
      </FormField>

      <SwitchRow
        id="setup-relay-also-node"
        label={t('nodes.setup.fields.relayAlsoNode')}
        hint={t('nodes.setup.fields.relayAlsoNodeHint')}
        checked={values.alsoNode}
        onCheckedChange={(checked) => onChange({ alsoNode: checked })}
      />
    </>
  );
}

/** 中继兼节点才建账号：纯中继没有网页，也就没有登录这回事。 */
function RelayAccountFields({
  values,
  shown,
  directSupported,
  platform,
  onChange,
}: {
  values: BecomeRelayValues;
  shown: Partial<Record<string, string>>;
  directSupported: boolean;
  platform: string;
  onChange: (patch: Partial<BecomeRelayValues>) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <FormField
        id="setup-relay-username"
        label={t('nodes.setup.fields.username')}
        hint={t('nodes.setup.fields.usernameHint')}
        error={shown.username && t(shown.username)}
      >
        <Input
          id="setup-relay-username"
          value={values.username}
          onChange={(event) => onChange({ username: event.target.value })}
          autoComplete="username"
          className="min-h-10"
        />
      </FormField>

      <FormField
        id="setup-relay-account-password"
        label={t('nodes.setup.fields.password')}
        hint={t('nodes.setup.fields.passwordHint')}
        error={shown.password && t(shown.password)}
      >
        <PasswordFieldWithGenerate
          id="setup-relay-account-password"
          value={values.password}
          onChange={(next) => onChange({ password: next })}
        />
      </FormField>

      <FormField
        id="setup-relay-confirm-password"
        label={t('nodes.setup.fields.confirmPassword')}
        error={shown.confirmPassword && t(shown.confirmPassword)}
      >
        <Input
          id="setup-relay-confirm-password"
          type="password"
          value={values.confirmPassword}
          onChange={(event) => onChange({ confirmPassword: event.target.value })}
          autoComplete="new-password"
          className="min-h-10"
        />
      </FormField>

      <SwitchRow
        id="setup-relay-direct-enable"
        label={t('nodes.setup.fields.directEnable')}
        hint={
          directSupported
            ? t('nodes.setup.fields.directEnableRelayHint')
            : t('nodes.setup.fields.directUnsupportedRelayHint', { platform })
        }
        checked={values.directEnable && directSupported}
        disabled={!directSupported}
        onCheckedChange={(checked) => onChange({ directEnable: checked })}
      />
    </>
  );
}

/** 提交成功：中继兼节点等重启回登录页；纯中继只说明网页即将不可用。 */
function BecomeRelayResult({
  result,
  waiter,
}: {
  result: SetupRelayResponse;
  waiter: RestartWaiter;
}) {
  const { t } = useTranslation();
  const pure = result.role === 'relay';
  return (
    <Card className="border-0 ring-0 tmex-reveal" data-testid="setup-become-relay-result">
      <CardHeader>
        <CardTitle>{t('nodes.setup.result.title')}</CardTitle>
        <CardDescription>
          {t(
            pure ? 'nodes.setup.result.relayDescription' : 'nodes.setup.result.relayNodeDescription'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ResultRow label={t('nodes.setup.result.relayPublicUrl')} value={result.relayPublicUrl} />
        <ResultRow
          label={t('nodes.setup.result.relayPassword')}
          value={t(result.hasPassword ? 'relay.admin.password.set' : 'relay.admin.password.unset')}
        />
        {result.fingerprint && (
          <ResultRow label={t('nodes.setup.result.fingerprint')} value={result.fingerprint} />
        )}
        {pure ? (
          <SetupNotice tone="warning" testId="setup-relay-web-gone">
            <p>{t('nodes.setup.result.relayWebGone')}</p>
            <p className="font-mono">tmex relay status</p>
          </SetupNotice>
        ) : (
          <RestartPanel waiter={waiter} />
        )}
      </CardContent>
    </Card>
  );
}
