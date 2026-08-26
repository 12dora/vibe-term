import type { AssistRegexResponse, WatchRuleDto, WatchTriggerType } from '@tmex/shared';
import { useCallback, useMemo, useState } from 'react';
import {
  type WatchRuleDraft,
  type WatchRuleValidationError,
  applyAssistResult,
  applyProviderId,
  applyTriggerType,
  createWatchRuleDraft,
  minIntervalFor,
  validateWatchRuleDraft,
} from './watch-rule-draft';

export type SetWatchRuleField = <K extends keyof WatchRuleDraft>(
  key: K,
  value: WatchRuleDraft[K]
) => void;

export interface WatchRuleDraftController {
  draft: WatchRuleDraft;
  setField: SetWatchRuleField;
  selectTriggerType: (next: WatchTriggerType) => void;
  selectProvider: (next: string | null) => void;
  acceptAssistResult: (result: AssistRegexResponse) => void;
  minInterval: number;
  validate: () => WatchRuleValidationError | null;
}

export function useWatchRuleDraft(rule: WatchRuleDto | null): WatchRuleDraftController {
  const [draft, setDraft] = useState<WatchRuleDraft>(() => createWatchRuleDraft(rule));

  const setField = useCallback<SetWatchRuleField>((key, value) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const selectTriggerType = useCallback((next: WatchTriggerType) => {
    setDraft((current) => applyTriggerType(current, next));
  }, []);

  const selectProvider = useCallback((next: string | null) => {
    setDraft((current) => applyProviderId(current, next));
  }, []);

  const acceptAssistResult = useCallback((result: AssistRegexResponse) => {
    setDraft((current) => applyAssistResult(current, result));
  }, []);

  const validate = useCallback(() => validateWatchRuleDraft(draft), [draft]);

  return useMemo(
    () => ({
      draft,
      setField,
      selectTriggerType,
      selectProvider,
      acceptAssistResult,
      minInterval: minIntervalFor(draft.triggerType),
      validate,
    }),
    [draft, setField, selectTriggerType, selectProvider, acceptAssistResult, validate]
  );
}
