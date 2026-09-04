import type { TelegramBotWithStats } from '@tmex/shared';

import {
  IntegrationAccountFormModal,
  type IntegrationFormConfig,
  nonEmptyText,
} from './integration-account-form-modal';

function telegramUpdatePayload(
  name: string,
  token: string,
  allowAuthRequests: unknown,
  allowCommands: unknown
) {
  const payload: Record<string, unknown> = { name, allowAuthRequests, allowCommands };
  if (token) {
    payload.token = token;
  }
  return payload;
}

export const telegramBotFormConfig: IntegrationFormConfig<TelegramBotWithStats> = {
  testIdPrefix: 'telegram-bot',
  queryKey: ['telegram-bots'],
  addTitleKey: 'telegram.addBot',
  editTitleKey: 'telegram.editBot',
  fields: [
    {
      kind: 'text',
      key: 'name',
      inputId: 'telegram-bot-name',
      testId: 'telegram-bot-name-input',
      labelKey: 'telegram.botName',
      placeholderKey: 'telegram.botNamePlaceholder',
      initialValue: (bot) => bot?.name ?? '',
      validate: nonEmptyText,
    },
    {
      kind: 'secret',
      key: 'token',
      inputId: 'telegram-bot-token',
      testId: 'telegram-bot-token-input',
      labelKey: 'telegram.botToken',
      placeholderKey: ({ isEdit }) =>
        isEdit ? 'telegram.tokenPlaceholder' : 'telegram.botTokenPlaceholder',
      initialValue: () => '',
      validate: (value, { isEdit }) => isEdit || nonEmptyText(value),
    },
    {
      kind: 'toggle',
      key: 'allowAuthRequests',
      inputId: 'telegram-bot-allow-auth',
      testId: 'telegram-bot-allow-auth',
      labelKey: 'telegram.allowAuthRequests',
      initialValue: (bot) => bot?.allowAuthRequests ?? true,
    },
    {
      kind: 'toggle',
      key: 'allowCommands',
      inputId: 'telegram-bot-allow-commands',
      testId: 'telegram-bot-allow-commands',
      labelKey: 'telegram.allowCommands',
      descriptionKey: 'telegram.allowCommandsHelp',
      initialValue: (bot) => bot?.allowCommands ?? false,
    },
  ],
  buildPayload: (values, { isEdit }) =>
    isEdit
      ? telegramUpdatePayload(
          String(values.name).trim(),
          String(values.token).trim(),
          values.allowAuthRequests,
          values.allowCommands
        )
      : {
          name: String(values.name).trim(),
          token: String(values.token).trim(),
          enabled: true,
          allowAuthRequests: values.allowAuthRequests,
          allowCommands: values.allowCommands,
        },
  create: {
    path: '/api/settings/telegram/bots',
    errorFallbackKey: 'telegram.createFailed',
    successToastKey: 'common.success',
  },
  update: {
    path: (bot) => `/api/settings/telegram/bots/${bot.id}`,
    errorFallbackKey: 'telegram.updateFailed',
    successToastKey: 'common.success',
  },
};

interface TelegramBotFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 缺省表示新增模式 */
  bot?: TelegramBotWithStats;
}

export function TelegramBotFormModal({ open, onOpenChange, bot }: TelegramBotFormModalProps) {
  return (
    <IntegrationAccountFormModal
      open={open}
      onOpenChange={onOpenChange}
      config={telegramBotFormConfig}
      entity={bot}
    />
  );
}
