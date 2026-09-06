// 新建映射表单的字段与提示行。表单本体只留下探测、提交条件与布局。

import { Button } from '@vibeterm/ui/button';
import { Input } from '@vibeterm/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vibeterm/ui/select';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { DialogNodeOption } from '../dialog-nodes';
import { NodeSelect } from '../node-select';
import {
  LISTEN_HOST_ANY,
  LISTEN_HOST_LOCAL,
  type PortMapFormState,
  type ProbeBlock,
  type SubmitBlock,
  validatePortMapForm,
} from './portmap-form-state';

export const SUBMIT_BLOCK_KEYS: Record<SubmitBlock, string> = {
  incomplete: 'devices.portmap.form.incomplete',
  invalidPort: 'devices.portmap.form.portRange',
  portTaken: 'devices.portmap.form.portInUse',
  sameNode: 'devices.portmap.form.sameNode',
};

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs" htmlFor={htmlFor}>
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function ListenHostSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (host: string) => void;
}) {
  const { t } = useTranslation();
  const label =
    value === LISTEN_HOST_ANY
      ? t('devices.portmap.form.listenHostAny')
      : t('devices.portmap.form.listenHostLocal');
  return (
    <Select
      value={value}
      onValueChange={(next: string | null) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger
        className="h-9 w-full"
        data-testid="portmap-listen-host"
        aria-label={t('devices.portmap.form.listenHost')}
      >
        <SelectValue>
          <span className="truncate">{label}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={LISTEN_HOST_LOCAL}>
          {t('devices.portmap.form.listenHostLocal')}
        </SelectItem>
        <SelectItem value={LISTEN_HOST_ANY}>{t('devices.portmap.form.listenHostAny')}</SelectItem>
      </SelectContent>
    </Select>
  );
}

export interface PortMapFormFieldsProps {
  state: PortMapFormState;
  options: DialogNodeOption[];
  patch: (next: Partial<PortMapFormState>) => void;
  submitting: boolean;
  block: SubmitBlock | null;
  onSubmit: () => void;
}

export function PortMapFormFields({
  state,
  options,
  patch,
  submitting,
  block,
  onSubmit,
}: PortMapFormFieldsProps) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <Field label={t('devices.portmap.form.listenNode')}>
        <NodeSelect
          value={state.listenNodeId}
          options={options}
          onChange={(nodeId) => patch({ listenNodeId: nodeId })}
          testId="portmap-listen-node"
          ariaLabel={t('devices.portmap.form.listenNode')}
        />
      </Field>
      <Field label={t('devices.portmap.form.listenHost')}>
        <ListenHostSelect
          value={state.listenHost}
          onChange={(host) => patch({ listenHost: host })}
        />
      </Field>
      <Field label={t('devices.portmap.form.listenPort')} htmlFor="portmap-listen-port">
        <Input
          id="portmap-listen-port"
          data-testid="portmap-listen-port"
          className="h-9"
          inputMode="numeric"
          value={state.listenPort}
          onChange={(event) => patch({ listenPort: event.target.value })}
        />
      </Field>
      <Field label={t('devices.portmap.form.nameOptional')} htmlFor="portmap-name">
        <Input
          id="portmap-name"
          data-testid="portmap-name"
          className="h-9"
          value={state.name}
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Field>
      <Field label={t('devices.portmap.form.targetNode')}>
        <NodeSelect
          value={state.targetNodeId}
          options={options}
          onChange={(nodeId) => patch({ targetNodeId: nodeId })}
          testId="portmap-target-node"
          ariaLabel={t('devices.portmap.form.targetNode')}
        />
      </Field>
      <Field label={t('devices.portmap.form.targetHost')} htmlFor="portmap-target-host">
        <Input
          id="portmap-target-host"
          data-testid="portmap-target-host"
          className="h-9 font-mono"
          value={state.targetHost}
          onChange={(event) => patch({ targetHost: event.target.value })}
        />
      </Field>
      <Field label={t('devices.portmap.form.targetPort')} htmlFor="portmap-target-port">
        <Input
          id="portmap-target-port"
          data-testid="portmap-target-port"
          className="h-9"
          inputMode="numeric"
          value={state.targetPort}
          onChange={(event) => patch({ targetPort: event.target.value })}
        />
      </Field>
      <div className="flex items-end">
        <Button
          className="w-full"
          size="sm"
          variant="secondary"
          data-testid="portmap-submit"
          title={block ? t(SUBMIT_BLOCK_KEYS[block]) : undefined}
          disabled={block !== null || submitting}
          onClick={onSubmit}
        >
          {submitting ? t('devices.portmap.form.submitting') : t('devices.portmap.form.submit')}
        </Button>
      </div>
    </div>
  );
}

export interface PortMapFormHintsProps {
  state: PortMapFormState;
  probeBlock: ProbeBlock | null;
  targetIdle: boolean;
  errorKey: string | null;
}

export function PortMapFormHints({
  state,
  probeBlock,
  targetIdle,
  errorKey,
}: PortMapFormHintsProps) {
  const { t } = useTranslation();
  const fieldErrors = validatePortMapForm(state);
  return (
    <div className="flex flex-col gap-0.5 text-[11px]">
      {state.listenHost === LISTEN_HOST_ANY && (
        <span className="text-muted-foreground" data-testid="portmap-any-warning">
          {t('devices.portmap.form.listenHostAnyWarning')}
        </span>
      )}
      {(fieldErrors.listenPort || fieldErrors.targetPort) && (
        <span className="text-destructive">{t('devices.portmap.form.portRange')}</span>
      )}
      {probeBlock && (
        <span className="text-destructive" data-testid="portmap-listen-probe">
          {t(
            probeBlock === 'reserved'
              ? 'devices.portmap.form.portReserved'
              : 'devices.portmap.form.portInUse'
          )}
        </span>
      )}
      {targetIdle && (
        <span className="text-muted-foreground" data-testid="portmap-target-probe">
          {t('devices.portmap.form.targetIdle')}
        </span>
      )}
      {errorKey && <span className="text-destructive">{t(errorKey)}</span>}
    </div>
  );
}
