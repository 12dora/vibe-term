import type { WeixinAccountWithStats } from '@tmex/shared';
import { useState } from 'react';

import {
  IntegrationAccountFormModal,
  type IntegrationFormConfig,
  nonEmptyText,
} from './integration-account-form-modal';
import { WeixinAccountLoginModal } from './weixin-account-login-modal';

interface CreateAccountResponse {
  success: boolean;
  accountId: string;
}

export const weixinAccountFormConfig: IntegrationFormConfig<WeixinAccountWithStats> = {
  testIdPrefix: 'weixin-account',
  queryKey: ['weixin-accounts'],
  addTitleKey: 'weixin.addAccount',
  editTitleKey: 'weixin.editAccount',
  fields: [
    {
      kind: 'text',
      key: 'name',
      inputId: 'weixin-account-name',
      testId: 'weixin-account-name-input',
      labelKey: 'weixin.accountName',
      placeholderKey: 'weixin.accountNamePlaceholder',
      initialValue: (account) => account?.name ?? '',
      validate: nonEmptyText,
    },
    {
      kind: 'toggle',
      key: 'enabled',
      inputId: 'weixin-account-enabled',
      testId: 'weixin-account-enabled',
      labelKey: 'weixin.enableAccount',
      initialValue: (account) => account?.enabled ?? true,
    },
    {
      kind: 'toggle',
      key: 'allowCommands',
      inputId: 'weixin-account-allow-commands',
      testId: 'weixin-account-allow-commands',
      labelKey: 'weixin.allowCommands',
      descriptionKey: 'weixin.allowCommandsHelp',
      initialValue: (account) => account?.allowCommands ?? false,
    },
  ],
  buildPayload: (values, { isEdit }) =>
    isEdit
      ? {
          name: String(values.name).trim(),
          enabled: values.enabled,
          allowCommands: values.allowCommands,
        }
      : {
          name: String(values.name).trim(),
          enabled: values.enabled,
          allowAuthRequests: true,
          allowCommands: values.allowCommands,
        },
  create: {
    path: '/api/settings/weixin/accounts',
    errorFallbackKey: 'weixin.createFailed',
    successToastKey: 'weixin.accountCreated',
    readResponse: true,
  },
  update: {
    path: (account) => `/api/settings/weixin/accounts/${account.id}`,
    errorFallbackKey: 'weixin.updateFailed',
    successToastKey: 'weixin.accountUpdated',
  },
};

interface WeixinAccountFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 缺省表示新增模式 */
  account?: WeixinAccountWithStats;
}

export function WeixinAccountFormModal({
  open,
  onOpenChange,
  account,
}: WeixinAccountFormModalProps) {
  const [loginAccount, setLoginAccount] = useState<{ id: string; name: string } | null>(null);

  return (
    <>
      <IntegrationAccountFormModal
        open={open}
        onOpenChange={onOpenChange}
        config={weixinAccountFormConfig}
        entity={account}
        onCreated={({ response, values }) => {
          setLoginAccount({
            id: (response as CreateAccountResponse).accountId,
            name: String(values.name).trim(),
          });
        }}
      />

      {loginAccount && (
        <WeixinAccountLoginModal
          open={Boolean(loginAccount)}
          onOpenChange={(next) => {
            if (!next) {
              setLoginAccount(null);
            }
          }}
          accountId={loginAccount.id}
          accountName={loginAccount.name}
        />
      )}
    </>
  );
}
