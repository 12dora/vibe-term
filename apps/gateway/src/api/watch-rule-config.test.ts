import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from '../db/client';
import { createLlmProvider } from '../db/llm';
import type { WatchRuleRecord } from '../db/watch';
import { t } from '../i18n';
import { compileWatchPattern } from '../watch/evaluator';
import {
  type WatchRuleEffective,
  type WatchRuleUpdates,
  buildEffectiveWatchRule,
  mergeWatchRuleEffective,
  parseWatchTriggerType,
  validateRuleSemantics,
} from './watch-rule-config';

let providerId = '';

function existingRule(overrides: Partial<WatchRuleRecord> = {}): WatchRuleRecord {
  return {
    id: 'rule-1',
    name: 'r',
    deviceId: 'dev',
    paneId: '%1',
    enabled: true,
    triggerType: 'match',
    pattern: 'ERROR',
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
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function patternInvalidDetail(pattern: string, flags: string): string {
  try {
    compileWatchPattern(pattern, flags);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  providerId = createLlmProvider({
    name: 'watch-config-provider',
    protocol: 'openai-chat',
    baseUrl: 'https://watch.example/v1',
    apiKeyEnc: 'enc',
    enabled: true,
  }).id;
});

describe('buildEffectiveWatchRule — create（existing=null）', () => {
  test('缺 triggerType → watchTriggerTypeInvalid', () => {
    expect(buildEffectiveWatchRule(null, { pattern: 'ERROR' })).toEqual({
      ok: false,
      error: t('apiError.watchTriggerTypeInvalid'),
    });
  });

  test('非法 triggerType', () => {
    expect(buildEffectiveWatchRule(null, { triggerType: 'bogus', pattern: 'ERROR' })).toEqual({
      ok: false,
      error: t('apiError.watchTriggerTypeInvalid'),
    });
  });

  const createCases: Array<
    {
      name: string;
      patch: Record<string, unknown>;
    } & ({ error: string } | { updates: WatchRuleUpdates; effective: WatchRuleEffective })
  > = [
    {
      name: 'match 缺 pattern（省略）→ watchPatternRequired；updates 不含 pattern',
      patch: { triggerType: 'match' },
      error: t('apiError.watchPatternRequired'),
    },
    {
      name: 'match 显式 pattern null → watchPatternRequired',
      patch: { triggerType: 'match', pattern: null },
      error: t('apiError.watchPatternRequired'),
    },
    {
      name: 'match 空字符串 pattern 被收成 null → watchPatternRequired',
      patch: { triggerType: 'match', pattern: '' },
      error: t('apiError.watchPatternRequired'),
    },
    {
      name: 'match 成功：interval 默认 30，flags 默认空，省略字段不进 updates',
      patch: { triggerType: 'match', pattern: 'ERROR' },
      updates: { triggerType: 'match', pattern: 'ERROR' },
      effective: {
        triggerType: 'match',
        pattern: 'ERROR',
        patternFlags: '',
        unchangedMinutes: null,
        conditionPrompt: null,
        intervalSeconds: 30,
      },
    },
    {
      name: 'llm 缺 conditionPrompt → watchConditionPromptRequired',
      patch: { triggerType: 'llm', pattern: null },
      error: t('apiError.watchConditionPromptRequired'),
    },
    {
      name: 'llm 成功：interval 默认 60；pattern 显式 null 出现在 updates',
      patch: { triggerType: 'llm', pattern: null, conditionPrompt: 'finished?' },
      updates: {
        triggerType: 'llm',
        pattern: null,
        conditionPrompt: 'finished?',
      },
      effective: {
        triggerType: 'llm',
        pattern: null,
        patternFlags: '',
        unchangedMinutes: null,
        conditionPrompt: 'finished?',
        intervalSeconds: 60,
      },
    },
    {
      name: 'llm conditionPrompt 空白视为 null',
      patch: { triggerType: 'llm', conditionPrompt: '   ' },
      error: t('apiError.watchConditionPromptRequired'),
    },
    {
      name: 'unchanged 省略 unchangedMinutes → 语义错误',
      patch: { triggerType: 'unchanged', pattern: '(\\d+)%' },
      error: t('apiError.watchUnchangedMinutesInvalid'),
    },
    {
      name: 'unchangedMinutes 字段级 0 非法',
      patch: { triggerType: 'unchanged', pattern: '(\\d+)%', unchangedMinutes: 0 },
      error: t('apiError.watchUnchangedMinutesInvalid'),
    },
    {
      name: 'unchanged 成功：显式 minutes 进入 updates 与 effective',
      patch: {
        triggerType: 'unchanged',
        pattern: '(\\d+)%',
        extractGroup: 1,
        unchangedMinutes: 5,
      },
      updates: {
        triggerType: 'unchanged',
        pattern: '(\\d+)%',
        extractGroup: 1,
        unchangedMinutes: 5,
      },
      effective: {
        triggerType: 'unchanged',
        pattern: '(\\d+)%',
        patternFlags: '',
        unchangedMinutes: 5,
        conditionPrompt: null,
        intervalSeconds: 30,
      },
    },
    {
      name: 'intervalSeconds 低于 match 下限 5',
      patch: { triggerType: 'match', pattern: 'a', intervalSeconds: 3 },
      error: t('apiError.watchIntervalInvalid', { min: 5 }),
    },
    {
      name: 'intervalSeconds 低于 llm 下限 30',
      patch: {
        triggerType: 'llm',
        conditionPrompt: 'done?',
        intervalSeconds: 20,
      },
      error: t('apiError.watchIntervalInvalid', { min: 30 }),
    },
    {
      name: 'extractGroup 非法',
      patch: { triggerType: 'match', pattern: 'a', extractGroup: -1 },
      error: t('apiError.watchExtractGroupInvalid'),
    },
    {
      name: 'extractGroup 非整数',
      patch: { triggerType: 'match', pattern: 'a', extractGroup: 1.5 },
      error: t('apiError.watchExtractGroupInvalid'),
    },
    {
      name: 'noMatchBehavior / fireMode / cooldown 非法',
      patch: { triggerType: 'match', pattern: 'a', noMatchBehavior: 'zap' },
      error: t('apiError.watchNoMatchBehaviorInvalid'),
    },
    {
      name: 'fireMode 非法',
      patch: { triggerType: 'match', pattern: 'a', fireMode: 'always' },
      error: t('apiError.watchFireModeInvalid'),
    },
    {
      name: 'cooldownSeconds < 0',
      patch: { triggerType: 'match', pattern: 'a', cooldownSeconds: -1 },
      error: t('apiError.watchCooldownInvalid'),
    },
    {
      name: 'enabled 非 boolean',
      patch: { triggerType: 'match', pattern: 'a', enabled: 'yes' },
      error: t('apiError.invalidRequest'),
    },
    {
      name: 'intervalSeconds 非整数',
      patch: { triggerType: 'match', pattern: 'a', intervalSeconds: 1.2 },
      error: t('apiError.invalidRequest'),
    },
    {
      name: 'providerId 不存在',
      patch: { triggerType: 'match', pattern: 'a', providerId: crypto.randomUUID() },
      error: t('apiError.llmProviderNotFound'),
    },
    {
      name: 'modelId 非字符串非 null',
      patch: { triggerType: 'match', pattern: 'a', modelId: 1 },
      error: t('apiError.invalidRequest'),
    },
    {
      name: 'modelId 空白收成 null 并写入 updates',
      patch: { triggerType: 'match', pattern: 'ERROR', modelId: '  ' },
      updates: { triggerType: 'match', pattern: 'ERROR', modelId: null },
      effective: {
        triggerType: 'match',
        pattern: 'ERROR',
        patternFlags: '',
        unchangedMinutes: null,
        conditionPrompt: null,
        intervalSeconds: 30,
      },
    },
    {
      name: 'providerId 显式 null 进入 updates',
      patch: { triggerType: 'match', pattern: 'ERROR', providerId: null },
      updates: { triggerType: 'match', pattern: 'ERROR', providerId: null },
      effective: {
        triggerType: 'match',
        pattern: 'ERROR',
        patternFlags: '',
        unchangedMinutes: null,
        conditionPrompt: null,
        intervalSeconds: 30,
      },
    },
  ];

  for (const c of createCases) {
    test(c.name, () => {
      const result = buildEffectiveWatchRule(null, c.patch);
      if ('error' in c) {
        expect(result).toEqual({ ok: false, error: c.error });
        return;
      }
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.updates).toEqual(c.updates);
        expect(result.effective).toEqual(c.effective);
      }
    });
  }

  test('无效 pattern 试编译失败', () => {
    const result = buildEffectiveWatchRule(null, { triggerType: 'match', pattern: '([' });
    expect(result).toEqual({
      ok: false,
      error: t('apiError.watchPatternInvalid', {
        detail: patternInvalidDetail('([', ''),
      }),
    });
  });

  test('非法 flags 被试编译拦下', () => {
    const result = buildEffectiveWatchRule(null, {
      triggerType: 'match',
      pattern: 'a',
      patternFlags: 'q',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        t('apiError.watchPatternInvalid', { detail: patternInvalidDetail('a', 'q') })
      );
    }
  });

  test('合法 providerId 进入 updates；省略则不出现', () => {
    const withProvider = buildEffectiveWatchRule(null, {
      triggerType: 'match',
      pattern: 'ERROR',
      providerId,
    });
    expect(withProvider.ok).toBe(true);
    if (withProvider.ok) {
      expect(withProvider.updates.providerId).toBe(providerId);
      expect('intervalSeconds' in withProvider.updates).toBe(false);
      expect(withProvider.effective.intervalSeconds).toBe(30);
    }

    const omitted = buildEffectiveWatchRule(null, {
      triggerType: 'match',
      pattern: 'ERROR',
    });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect('providerId' in omitted.updates).toBe(false);
    }
  });
});

describe('buildEffectiveWatchRule — update（有 existing）', () => {
  test('空 patch：updates 为空，effective 来自 existing', () => {
    const existing = existingRule();
    expect(buildEffectiveWatchRule(existing, {})).toEqual({
      ok: true,
      updates: {},
      effective: {
        triggerType: 'match',
        pattern: 'ERROR',
        patternFlags: '',
        unchangedMinutes: null,
        conditionPrompt: null,
        intervalSeconds: 30,
      },
    });
  });

  test('pattern 省略保留 existing；显式 null 清空并触发语义错误', () => {
    const existing = existingRule();
    const omitted = buildEffectiveWatchRule(existing, { enabled: false });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect('pattern' in omitted.updates).toBe(false);
      expect(omitted.effective.pattern).toBe('ERROR');
      expect(omitted.updates.enabled).toBe(false);
    }

    expect(buildEffectiveWatchRule(existing, { pattern: null })).toEqual({
      ok: false,
      error: t('apiError.watchPatternRequired'),
    });
  });

  test('改成 llm 但省略 conditionPrompt：用 existing.conditionPrompt（null）拦下', () => {
    const existing = existingRule();
    expect(buildEffectiveWatchRule(existing, { triggerType: 'llm' })).toEqual({
      ok: false,
      error: t('apiError.watchConditionPromptRequired'),
    });
  });

  test('合法类型切换：triggerType+conditionPrompt+interval 都进 updates', () => {
    const existing = existingRule();
    const result = buildEffectiveWatchRule(existing, {
      triggerType: 'llm',
      conditionPrompt: 'is it done?',
      intervalSeconds: 60,
    });
    expect(result).toEqual({
      ok: true,
      updates: {
        triggerType: 'llm',
        conditionPrompt: 'is it done?',
        intervalSeconds: 60,
      },
      effective: {
        triggerType: 'llm',
        pattern: 'ERROR',
        patternFlags: '',
        unchangedMinutes: null,
        conditionPrompt: 'is it done?',
        intervalSeconds: 60,
      },
    });
  });

  test('unchangedMinutes 省略保留 existing；显式 null 写入 updates', () => {
    const existing = existingRule({
      triggerType: 'unchanged',
      pattern: '(\\d+)%',
      unchangedMinutes: 8,
    });
    const omitted = buildEffectiveWatchRule(existing, { enabled: true });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect('unchangedMinutes' in omitted.updates).toBe(false);
      expect(omitted.effective.unchangedMinutes).toBe(8);
    }

    expect(buildEffectiveWatchRule(existing, { unchangedMinutes: null })).toEqual({
      ok: false,
      error: t('apiError.watchUnchangedMinutesInvalid'),
    });
  });

  test('conditionPrompt 省略保留 existing；空白/null 清空', () => {
    const existing = existingRule({
      triggerType: 'llm',
      pattern: null,
      conditionPrompt: 'still going?',
      intervalSeconds: 60,
    });
    const omitted = buildEffectiveWatchRule(existing, { enabled: false });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect('conditionPrompt' in omitted.updates).toBe(false);
      expect(omitted.effective.conditionPrompt).toBe('still going?');
    }

    expect(buildEffectiveWatchRule(existing, { conditionPrompt: null })).toEqual({
      ok: false,
      error: t('apiError.watchConditionPromptRequired'),
    });
    expect(buildEffectiveWatchRule(existing, { conditionPrompt: '  ' })).toEqual({
      ok: false,
      error: t('apiError.watchConditionPromptRequired'),
    });
  });

  test('intervalSeconds 省略用 existing；改 triggerType 时按合成值验下限', () => {
    const existing = existingRule({ intervalSeconds: 10 });
    const keep = buildEffectiveWatchRule(existing, { enabled: true });
    expect(keep.ok).toBe(true);
    if (keep.ok) {
      expect('intervalSeconds' in keep.updates).toBe(false);
      expect(keep.effective.intervalSeconds).toBe(10);
    }

    expect(buildEffectiveWatchRule(existing, { triggerType: 'llm', conditionPrompt: 'x' })).toEqual(
      {
        ok: false,
        error: t('apiError.watchIntervalInvalid', { min: 30 }),
      }
    );
  });

  test('providerId/modelId 省略 vs 显式 null', () => {
    const existing = existingRule({ providerId, modelId: 'mock-model' });
    const omitted = buildEffectiveWatchRule(existing, { enabled: true });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect('providerId' in omitted.updates).toBe(false);
      expect('modelId' in omitted.updates).toBe(false);
    }

    const cleared = buildEffectiveWatchRule(existing, {
      providerId: null,
      modelId: null,
    });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.updates.providerId).toBeNull();
      expect(cleared.updates.modelId).toBeNull();
    }
  });

  test('patternFlags 省略保留 existing；显式写入', () => {
    const existing = existingRule({ patternFlags: 'i' });
    const omitted = buildEffectiveWatchRule(existing, { enabled: true });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect('patternFlags' in omitted.updates).toBe(false);
      expect(omitted.effective.patternFlags).toBe('i');
    }

    const patched = buildEffectiveWatchRule(existing, { patternFlags: 'm' });
    expect(patched.ok).toBe(true);
    if (patched.ok) {
      expect(patched.updates.patternFlags).toBe('m');
      expect(patched.effective.patternFlags).toBe('m');
    }
  });
});

describe('parseWatchTriggerType', () => {
  test('create 缺 triggerType / 非法值 → watchTriggerTypeInvalid', () => {
    expect(parseWatchTriggerType({}, null)).toEqual({
      ok: false,
      error: t('apiError.watchTriggerTypeInvalid'),
    });
    expect(parseWatchTriggerType({ triggerType: 'bogus' }, null)).toEqual({
      ok: false,
      error: t('apiError.watchTriggerTypeInvalid'),
    });
  });

  test('patch 显式合法值覆盖 existing', () => {
    expect(parseWatchTriggerType({ triggerType: 'llm' }, existingRule())).toEqual({
      ok: true,
      value: 'llm',
    });
  });

  test('省略时用 existing', () => {
    expect(parseWatchTriggerType({}, existingRule({ triggerType: 'unchanged' }))).toEqual({
      ok: true,
      value: 'unchanged',
    });
  });
});

describe('mergeWatchRuleEffective', () => {
  test('create：llm interval 默认 60，match 默认 30', () => {
    expect(mergeWatchRuleEffective(null, {}, 'llm').intervalSeconds).toBe(60);
    expect(mergeWatchRuleEffective(null, {}, 'match').intervalSeconds).toBe(30);
  });

  test('fields 覆盖 existing；省略则保留 existing', () => {
    const existing = existingRule({
      pattern: 'OLD',
      patternFlags: 'i',
      unchangedMinutes: 8,
      conditionPrompt: 'keep',
      intervalSeconds: 12,
    });
    expect(mergeWatchRuleEffective(existing, { pattern: 'NEW' }, 'match')).toEqual({
      triggerType: 'match',
      pattern: 'NEW',
      patternFlags: 'i',
      unchangedMinutes: 8,
      conditionPrompt: 'keep',
      intervalSeconds: 12,
    });
  });

  test('显式 null 覆盖 existing 字符串', () => {
    const existing = existingRule({ pattern: 'OLD', conditionPrompt: 'p' });
    expect(
      mergeWatchRuleEffective(existing, { pattern: null, conditionPrompt: null }, 'llm')
    ).toMatchObject({
      pattern: null,
      conditionPrompt: null,
    });
  });
});

describe('validateRuleSemantics', () => {
  test('match 缺 pattern / 非法 pattern', () => {
    expect(
      validateRuleSemantics({
        triggerType: 'match',
        pattern: null,
        patternFlags: '',
        unchangedMinutes: null,
        conditionPrompt: null,
        intervalSeconds: 30,
      })
    ).toBe(t('apiError.watchPatternRequired'));

    expect(
      validateRuleSemantics({
        triggerType: 'match',
        pattern: '([',
        patternFlags: '',
        unchangedMinutes: null,
        conditionPrompt: null,
        intervalSeconds: 30,
      })
    ).toBe(t('apiError.watchPatternInvalid', { detail: patternInvalidDetail('([', '') }));
  });

  test('unchanged 要求 minutes；llm 要求 prompt；interval 下限', () => {
    expect(
      validateRuleSemantics({
        triggerType: 'unchanged',
        pattern: 'a',
        patternFlags: '',
        unchangedMinutes: null,
        conditionPrompt: null,
        intervalSeconds: 30,
      })
    ).toBe(t('apiError.watchUnchangedMinutesInvalid'));

    expect(
      validateRuleSemantics({
        triggerType: 'llm',
        pattern: null,
        patternFlags: '',
        unchangedMinutes: null,
        conditionPrompt: '  ',
        intervalSeconds: 60,
      })
    ).toBe(t('apiError.watchConditionPromptRequired'));

    expect(
      validateRuleSemantics({
        triggerType: 'llm',
        pattern: null,
        patternFlags: '',
        unchangedMinutes: null,
        conditionPrompt: 'x',
        intervalSeconds: 20,
      })
    ).toBe(t('apiError.watchIntervalInvalid', { min: 30 }));
  });
});
