// HTTPS 区块内部共用的展示件：通用原语取自 settings/components，这里只留本区块特有的排版差异。

import { Input } from '@tmex/ui/input';
import { useTranslation } from 'react-i18next';
import {
  FormField,
  type FormFieldProps,
  InfoRow as InfoRowBase,
  type InfoRowProps,
} from '../../components/form-primitives';
import { CopyableValue } from '../copy-feedback';

export { Notice, type NoticeTone } from '../../components/form-primitives';

export function Field(props: Omit<FormFieldProps, 'spacing'>) {
  return <FormField {...props} spacing="tight" />;
}

export function InfoRow(props: Omit<InfoRowProps, 'labelWidth'>) {
  return <InfoRowBase {...props} labelWidth="wide" />;
}

/** 监听端口 / 绑定地址：契约要求前端只给文字提示，绝不自动探测。 */
export function ListenerFields({
  port,
  bindHost,
  portError,
  hostError,
  disabled,
  idPrefix,
  onPortChange,
  onBindHostChange,
}: {
  port: string;
  bindHost: string;
  portError?: string;
  hostError?: string;
  disabled: boolean;
  idPrefix: string;
  onPortChange: (value: string) => void;
  onBindHostChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field
        id={`${idPrefix}-port`}
        label={t('nodes.https.port')}
        hint={t('nodes.https.portHint')}
        {...(portError ? { error: portError } : {})}
      >
        <Input
          id={`${idPrefix}-port`}
          data-testid={`${idPrefix}-port`}
          inputMode="numeric"
          value={port}
          disabled={disabled}
          onChange={(event) => onPortChange(event.target.value)}
        />
      </Field>
      <Field
        id={`${idPrefix}-bind-host`}
        label={t('nodes.https.bindHost')}
        hint={t('nodes.https.bindHostHint')}
        {...(hostError ? { error: hostError } : {})}
      >
        <Input
          id={`${idPrefix}-bind-host`}
          data-testid={`${idPrefix}-bind-host`}
          value={bindHost}
          disabled={disabled}
          onChange={(event) => onBindHostChange(event.target.value)}
        />
      </Field>
    </div>
  );
}

export function CopyableCode({ value, testId }: { value: string; testId: string }) {
  return <CopyableValue value={value} testId={testId} mono />;
}
