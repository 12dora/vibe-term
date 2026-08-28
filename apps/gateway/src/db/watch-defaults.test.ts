import { describe, expect, test } from 'bun:test';
import { applyWatchRuleCreateDefaults } from './watch';

const REQUIRED = {
  name: 'cpu',
  deviceId: 'dev-1',
  paneId: '%1',
  triggerType: 'match' as const,
};

describe('applyWatchRuleCreateDefaults', () => {
  test('省略可选字段时填入与 createWatchRule 相同的默认值', () => {
    expect(applyWatchRuleCreateDefaults(REQUIRED)).toEqual({
      name: 'cpu',
      deviceId: 'dev-1',
      paneId: '%1',
      triggerType: 'match',
      enabled: true,
      pattern: null,
      patternFlags: '',
      extractGroup: 0,
      conditionPrompt: null,
      providerId: null,
      modelId: null,
      confirmWithLlm: false,
      summarizeWithLlm: false,
      intervalSeconds: 30,
      unchangedMinutes: null,
      noMatchBehavior: 'reset',
      fireMode: 'once',
      cooldownSeconds: 600,
    });
  });

  test('显式 false / 0 / 空串不被默认值覆盖', () => {
    expect(
      applyWatchRuleCreateDefaults({
        ...REQUIRED,
        enabled: false,
        pattern: '',
        patternFlags: 'i',
        extractGroup: 0,
        conditionPrompt: '',
        providerId: null,
        modelId: '',
        confirmWithLlm: true,
        summarizeWithLlm: true,
        intervalSeconds: 0,
        unchangedMinutes: 0,
        noMatchBehavior: 'ignore',
        fireMode: 'repeat',
        cooldownSeconds: 0,
      })
    ).toEqual({
      name: 'cpu',
      deviceId: 'dev-1',
      paneId: '%1',
      triggerType: 'match',
      enabled: false,
      pattern: '',
      patternFlags: 'i',
      extractGroup: 0,
      conditionPrompt: '',
      providerId: null,
      modelId: '',
      confirmWithLlm: true,
      summarizeWithLlm: true,
      intervalSeconds: 0,
      unchangedMinutes: 0,
      noMatchBehavior: 'ignore',
      fireMode: 'repeat',
      cooldownSeconds: 0,
    });
  });

  test('required 字段原样透传', () => {
    const result = applyWatchRuleCreateDefaults({
      name: 'other',
      deviceId: 'd2',
      paneId: '%9',
      triggerType: 'llm',
    });
    expect(result.name).toBe('other');
    expect(result.deviceId).toBe('d2');
    expect(result.paneId).toBe('%9');
    expect(result.triggerType).toBe('llm');
  });
});
