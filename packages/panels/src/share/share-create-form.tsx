// 创建分享表单：名称 / 有效期 / 密码 / 地址。校验与时长换算在 share-dialog-model。

import type { ShareOriginCandidate } from '@tmex/shared/share';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { Loader2, RefreshCw } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SHARE_DURATION_CHOICES,
  type ShareDraft,
  type ShareDurationChoice,
  type ShareDurationUnit,
} from './share-dialog-model';

export type SetShareDraftField = <K extends keyof ShareDraft>(key: K, value: ShareDraft[K]) => void;

export interface ShareCreateFormProps {
  draft: ShareDraft;
  setField: SetShareDraftField;
  onRegeneratePassword: () => void;
  candidates: readonly ShareOriginCandidate[];
  submitting: boolean;
  onSubmit: () => void;
}

const DURATION_UNITS: readonly ShareDurationUnit[] = ['hours', 'days'];

function isDurationChoice(value: string): value is ShareDurationChoice {
  return (SHARE_DURATION_CHOICES as readonly string[]).includes(value);
}

function DurationField({ draft, setField }: { draft: ShareDraft; setField: SetShareDraftField }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium">{t('share.dialog.duration.label')}</span>
      <div className="flex items-center gap-2">
        <Select
          value={draft.duration}
          onValueChange={(value: string | null) => {
            if (value && isDurationChoice(value)) setField('duration', value);
          }}
        >
          <SelectTrigger className="w-full" data-testid="share-duration">
            <SelectValue>{t(`share.dialog.duration.${draft.duration}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SHARE_DURATION_CHOICES.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {t(`share.dialog.duration.${choice}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {draft.duration === 'custom' && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            step={1}
            className="w-24"
            value={draft.customValue}
            data-testid="share-duration-value"
            aria-label={t('share.dialog.duration.custom')}
            onChange={(event) => setField('customValue', event.target.value)}
          />
          <Select
            value={draft.customUnit}
            onValueChange={(value: string | null) => {
              if (value === 'hours' || value === 'days') setField('customUnit', value);
            }}
          >
            <SelectTrigger className="w-28" data-testid="share-duration-unit">
              <SelectValue>{t(`share.dialog.duration.unit.${draft.customUnit}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {DURATION_UNITS.map((unit) => (
                <SelectItem key={unit} value={unit}>
                  {t(`share.dialog.duration.unit.${unit}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

function PasswordField({
  formId,
  draft,
  setField,
  onRegenerate,
}: {
  formId: string;
  draft: ShareDraft;
  setField: SetShareDraftField;
  onRegenerate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor={`${formId}-password`}>
        {t('share.dialog.password')}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={`${formId}-password`}
          data-testid="share-password"
          className="font-mono"
          value={draft.password}
          autoComplete="off"
          onChange={(event) => setField('password', event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRegenerate}
          data-testid="share-password-regenerate"
          aria-label={t('share.dialog.regenerate')}
        >
          <RefreshCw className="h-4 w-4" />
          {t('share.dialog.regenerate')}
        </Button>
      </div>
    </div>
  );
}

function AddressField({
  draft,
  setField,
  candidates,
}: {
  draft: ShareDraft;
  setField: SetShareDraftField;
  candidates: readonly ShareOriginCandidate[];
}) {
  const { t } = useTranslation();
  const selected = candidates.find((candidate) => candidate.url === draft.origin);
  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium">{t('share.dialog.address')}</span>
      {candidates.length === 0 ? (
        <p className="text-sm text-destructive" data-testid="share-no-address">
          {t('share.dialog.noAddress')}
        </p>
      ) : (
        <Select
          value={draft.origin}
          onValueChange={(value: string | null) => {
            if (value) setField('origin', value);
          }}
        >
          <SelectTrigger className="w-full" data-testid="share-origin">
            <SelectValue>{selected?.label ?? draft.origin}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {candidates.map((candidate) => (
              <SelectItem key={candidate.url} value={candidate.url}>
                {candidate.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

export function ShareCreateForm({
  draft,
  setField,
  onRegeneratePassword,
  candidates,
  submitting,
  onSubmit,
}: ShareCreateFormProps) {
  const { t } = useTranslation();
  const formId = useId();

  return (
    <form
      data-testid="share-create-form"
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor={`${formId}-name`}>
          {t('share.dialog.name')}
        </label>
        <Input
          id={`${formId}-name`}
          data-testid="share-name"
          value={draft.name}
          maxLength={120}
          placeholder={t('share.dialog.namePlaceholder')}
          onChange={(event) => setField('name', event.target.value)}
        />
      </div>

      <DurationField draft={draft} setField={setField} />
      <PasswordField
        formId={formId}
        draft={draft}
        setField={setField}
        onRegenerate={onRegeneratePassword}
      />
      <AddressField draft={draft} setField={setField} candidates={candidates} />

      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={submitting || candidates.length === 0}
          data-testid="share-create-submit"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('share.dialog.create')}
        </Button>
      </div>
    </form>
  );
}
