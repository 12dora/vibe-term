import { describe, expect, test } from 'bun:test';
import type { CreateWatchRuleRequest, WatchRuleDto } from '@tmex/shared';
import {
  TRIGGER_TYPES,
  type WatchRuleDraft,
  type WatchRuleValidationError,
  applyAssistResult,
  applyProviderId,
  applyTriggerType,
  buildAssistRegexRequest,
  buildCreateWatchRuleRequest,
  buildUpdateWatchRuleRequest,
  createWatchRuleDraft,
  isRegexTrigger,
  minIntervalFor,
  needsModelFor,
  normalizeCooldownSeconds,
  normalizeExtractGroup,
  normalizeIntervalSeconds,
  normalizeModelId,
  normalizeUnchangedMinutes,
  validateWatchRuleDraft,
} from './watch-rule-draft';

function draftWith(overrides: Partial<WatchRuleDraft> = {}): WatchRuleDraft {
  return { ...createWatchRuleDraft(null), ...overrides };
}

const PAYLOAD_KEYS = [
  'name',
  'triggerType',
  'pattern',
  'patternFlags',
  'extractGroup',
  'conditionPrompt',
  'providerId',
  'modelId',
  'confirmWithLlm',
  'summarizeWithLlm',
  'intervalSeconds',
  'unchangedMinutes',
  'noMatchBehavior',
  'fireMode',
  'cooldownSeconds',
];

describe('createWatchRuleDraft', () => {
  test('新建规则使用固定默认值', () => {
    expect(createWatchRuleDraft(null)).toEqual({
      name: '',
      triggerType: 'match',
      pattern: '',
      patternFlags: '',
      extractGroup: 0,
      unchangedMinutes: 10,
      noMatchBehavior: 'reset',
      conditionPrompt: '',
      providerId: null,
      modelId: '',
      confirmWithLlm: false,
      summarizeWithLlm: false,
      intervalSeconds: 30,
      fireMode: 'once',
      cooldownSeconds: 600,
    });
  });

  test('编辑时把 DTO 的 null 字段折叠成表单可用值', () => {
    const rule: WatchRuleDto = {
      id: 'r1',
      name: 'existing',
      deviceId: 'dev',
      paneId: 'pane',
      enabled: true,
      triggerType: 'llm',
      pattern: null,
      patternFlags: '',
      extractGroup: 2,
      conditionPrompt: 'build finished?',
      providerId: null,
      modelId: null,
      confirmWithLlm: false,
      summarizeWithLlm: true,
      intervalSeconds: 90,
      unchangedMinutes: null,
      noMatchBehavior: 'ignore',
      fireMode: 'repeat',
      cooldownSeconds: 120,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(createWatchRuleDraft(rule)).toMatchObject({
      name: 'existing',
      triggerType: 'llm',
      pattern: '',
      modelId: '',
      unchangedMinutes: 10,
      conditionPrompt: 'build finished?',
      intervalSeconds: 90,
      noMatchBehavior: 'ignore',
      fireMode: 'repeat',
      cooldownSeconds: 120,
    });
  });
});

describe('createWatchRuleDraft 按触发类型', () => {
  function ruleDto(overrides: Partial<WatchRuleDto>): WatchRuleDto {
    return {
      id: 'r1',
      name: 'rule',
      deviceId: 'dev',
      paneId: 'pane',
      enabled: true,
      triggerType: 'match',
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
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  test.each([
    [
      'match',
      ruleDto({ triggerType: 'match', pattern: 'DL (\\d+)%', patternFlags: 'i', extractGroup: 1 }),
      { pattern: 'DL (\\d+)%', patternFlags: 'i', extractGroup: 1, unchangedMinutes: 10 },
    ],
    [
      'unchanged',
      ruleDto({ triggerType: 'unchanged', pattern: 'idle', unchangedMinutes: 3 }),
      { pattern: 'idle', unchangedMinutes: 3, conditionPrompt: '' },
    ],
    [
      'llm',
      ruleDto({
        triggerType: 'llm',
        conditionPrompt: 'done?',
        providerId: 'p1',
        modelId: 'gpt-4o',
        intervalSeconds: 90,
      }),
      { conditionPrompt: 'done?', providerId: 'p1', modelId: 'gpt-4o', intervalSeconds: 90 },
    ],
  ])('%s 型规则回填表单字段', (_label, rule, expected) => {
    const draft = createWatchRuleDraft(rule);
    expect(draft).toMatchObject(expected);
    expect(draft.triggerType).toBe(rule.triggerType);
  });

  test.each(TRIGGER_TYPES)('%s 型规则的空字段一律回落到新建默认值', (triggerType) => {
    const draft = createWatchRuleDraft(ruleDto({ triggerType }));
    const blank = createWatchRuleDraft(null);
    expect(draft).toEqual({ ...blank, name: 'rule', triggerType });
  });

  test('每次新建返回独立对象，互不影响', () => {
    const first = createWatchRuleDraft(null);
    first.name = 'mutated';
    expect(createWatchRuleDraft(null).name).toBe('');
  });
});

describe('trigger 元数据', () => {
  test('触发类型顺序固定', () => {
    expect(TRIGGER_TYPES).toEqual(['match', 'unchanged', 'llm']);
  });

  test.each([
    ['match', 5, true],
    ['unchanged', 5, true],
    ['llm', 30, false],
  ] as const)('%s 的最小间隔与正则属性', (triggerType, min, regex) => {
    expect(minIntervalFor(triggerType)).toBe(min);
    expect(isRegexTrigger(triggerType)).toBe(regex);
  });

  test.each([
    [draftWith({ triggerType: 'match' }), false],
    [draftWith({ triggerType: 'match', confirmWithLlm: true }), true],
    [draftWith({ triggerType: 'match', summarizeWithLlm: true }), true],
    [draftWith({ triggerType: 'llm' }), true],
  ])('needsModelFor', (draft, expected) => {
    expect(needsModelFor(draft)).toBe(expected);
  });
});

describe('applyTriggerType', () => {
  test.each([
    ['match', 'llm', 30, 30],
    ['match', 'llm', 10, 60],
    ['llm', 'match', 60, 60],
    ['llm', 'unchanged', 3, 30],
    ['match', 'unchanged', 5, 5],
  ] as const)('%s -> %s 时 interval %d 变为 %d', (from, to, intervalSeconds, expected) => {
    const next = applyTriggerType(draftWith({ triggerType: from, intervalSeconds }), to);
    expect(next.triggerType).toBe(to);
    expect(next.intervalSeconds).toBe(expected);
  });

  test('切换触发类型不清空其它字段', () => {
    const draft = draftWith({
      pattern: 'DL (\\d+)%',
      patternFlags: 'i',
      conditionPrompt: 'done?',
      confirmWithLlm: true,
      extractGroup: 1,
      unchangedMinutes: 7,
    });
    expect(applyTriggerType(draft, 'llm')).toMatchObject({
      pattern: 'DL (\\d+)%',
      patternFlags: 'i',
      conditionPrompt: 'done?',
      confirmWithLlm: true,
      extractGroup: 1,
      unchangedMinutes: 7,
    });
  });
});

describe('applyProviderId / applyAssistResult', () => {
  test('回到跟随全局默认时清空模型', () => {
    const draft = draftWith({ providerId: 'p1', modelId: 'gpt-4o' });
    expect(applyProviderId(draft, null)).toMatchObject({ providerId: null, modelId: '' });
  });

  test('切换到具体供应商时保留已填模型', () => {
    const draft = draftWith({ providerId: null, modelId: 'gpt-4o' });
    expect(applyProviderId(draft, 'p2')).toMatchObject({ providerId: 'p2', modelId: 'gpt-4o' });
  });

  test('assist 结果只覆盖 pattern / flags / extractGroup', () => {
    const draft = draftWith({ name: 'keep', pattern: 'old', patternFlags: 'm', extractGroup: 0 });
    expect(
      applyAssistResult(draft, {
        pattern: 'DL (\\d+)%',
        flags: 'i',
        extractGroup: 1,
        explanation: 'x',
        preview: [],
      })
    ).toMatchObject({ name: 'keep', pattern: 'DL (\\d+)%', patternFlags: 'i', extractGroup: 1 });
  });
});

describe('数字输入归一化', () => {
  test.each([
    ['', 0],
    ['abc', 0],
    ['-3', 0],
    ['2', 2],
  ])('normalizeExtractGroup(%p)', (raw, expected) => {
    expect(normalizeExtractGroup(raw)).toBe(expected);
  });

  test.each([
    ['', 1],
    ['0', 1],
    ['-5', 1],
    ['12', 12],
  ])('normalizeUnchangedMinutes(%p)', (raw, expected) => {
    expect(normalizeUnchangedMinutes(raw)).toBe(expected);
  });

  test.each([
    ['', 0],
    ['abc', 0],
    ['-7', -7],
    ['45', 45],
  ])('normalizeIntervalSeconds(%p)', (raw, expected) => {
    expect(normalizeIntervalSeconds(raw)).toBe(expected);
  });

  test.each([
    ['', 0],
    ['-10', 0],
    ['300', 300],
  ])('normalizeCooldownSeconds(%p)', (raw, expected) => {
    expect(normalizeCooldownSeconds(raw)).toBe(expected);
  });

  test.each([
    [null, 'gpt-4o', null],
    ['p1', '  ', null],
    ['p1', '  gpt-4o ', 'gpt-4o'],
  ] as const)('normalizeModelId(%p, %p)', (providerId, modelId, expected) => {
    expect(normalizeModelId(providerId, modelId)).toBe(expected);
  });
});

describe('validateWatchRuleDraft', () => {
  const invalidCases: Array<[string, WatchRuleDraft, WatchRuleValidationError]> = [
    [
      'match: 名称为空',
      draftWith({ name: '   ', pattern: 'x' }),
      { key: 'watch.validation.nameRequired' },
    ],
    [
      'match: 缺少 pattern',
      draftWith({ name: 'rule', pattern: '' }),
      { key: 'watch.validation.patternRequired' },
    ],
    [
      'unchanged: 缺少 pattern',
      draftWith({ name: 'rule', triggerType: 'unchanged', pattern: '' }),
      { key: 'watch.validation.patternRequired' },
    ],
    [
      'unchanged: minutes 非法',
      draftWith({
        name: 'rule',
        triggerType: 'unchanged',
        pattern: 'x',
        unchangedMinutes: 0,
      }),
      { key: 'watch.validation.unchangedMinutesInvalid' },
    ],
    [
      'llm: 缺少条件描述',
      draftWith({ name: 'rule', triggerType: 'llm', conditionPrompt: '  ' }),
      { key: 'watch.validation.conditionPromptRequired' },
    ],
    [
      'match: interval 小于 5',
      draftWith({ name: 'rule', pattern: 'x', intervalSeconds: 4 }),
      { key: 'watch.validation.intervalMin', params: { min: 5 } },
    ],
    [
      'llm: interval 小于 30',
      draftWith({
        name: 'rule',
        triggerType: 'llm',
        conditionPrompt: 'done?',
        intervalSeconds: 29,
      }),
      { key: 'watch.validation.intervalMin', params: { min: 30 } },
    ],
    [
      'match: interval 非整数',
      draftWith({ name: 'rule', pattern: 'x', intervalSeconds: 30.5 }),
      { key: 'watch.validation.intervalMin', params: { min: 5 } },
    ],
  ];

  test.each(invalidCases)('%s', (_label, draft, expected) => {
    expect(validateWatchRuleDraft(draft)).toEqual(expected);
  });

  test('非法正则返回 patternInvalid 并带上引擎错误详情', () => {
    const error = validateWatchRuleDraft(draftWith({ name: 'rule', pattern: '(' }));
    expect(error?.key).toBe('watch.validation.patternInvalid');
    expect(typeof error?.params?.detail).toBe('string');
    expect(String(error?.params?.detail).length).toBeGreaterThan(0);
  });

  test('g flag 在校验时被剥离（服务端自动追加）', () => {
    expect(
      validateWatchRuleDraft(draftWith({ name: 'rule', pattern: 'a', patternFlags: 'g' }))
    ).toBeNull();
  });

  test('llm 型不校验 pattern', () => {
    expect(
      validateWatchRuleDraft(
        draftWith({ name: 'rule', triggerType: 'llm', pattern: '(', conditionPrompt: 'done?' })
      )
    ).toBeNull();
  });

  test.each([
    ['match', draftWith({ name: 'rule', pattern: 'a' })],
    [
      'unchanged',
      draftWith({ name: 'rule', triggerType: 'unchanged', pattern: 'a', unchangedMinutes: 3 }),
    ],
    ['llm', draftWith({ name: 'rule', triggerType: 'llm', conditionPrompt: 'done?' })],
  ])('%s 型合法草稿通过校验', (_label, draft) => {
    expect(validateWatchRuleDraft(draft)).toBeNull();
  });
});

describe('payload 构造', () => {
  const filled = draftWith({
    name: '  spot check  ',
    pattern: 'DL (\\d+)%',
    patternFlags: 'i',
    extractGroup: 1,
    unchangedMinutes: 7,
    noMatchBehavior: 'ignore',
    conditionPrompt: 'build finished?',
    providerId: 'p1',
    modelId: ' gpt-4o ',
    confirmWithLlm: true,
    summarizeWithLlm: true,
    intervalSeconds: 45,
    fireMode: 'repeat',
    cooldownSeconds: 120,
  });

  test.each([
    [
      'match',
      { ...filled, triggerType: 'match' as const },
      {
        pattern: 'DL (\\d+)%',
        patternFlags: 'i',
        conditionPrompt: null,
        unchangedMinutes: null,
        confirmWithLlm: true,
        summarizeWithLlm: true,
      },
    ],
    [
      'unchanged',
      { ...filled, triggerType: 'unchanged' as const },
      {
        pattern: 'DL (\\d+)%',
        patternFlags: 'i',
        conditionPrompt: null,
        unchangedMinutes: 7,
        confirmWithLlm: true,
        summarizeWithLlm: true,
      },
    ],
    [
      'llm',
      { ...filled, triggerType: 'llm' as const },
      {
        pattern: null,
        patternFlags: '',
        conditionPrompt: 'build finished?',
        unchangedMinutes: null,
        confirmWithLlm: false,
        summarizeWithLlm: false,
      },
    ],
  ])('%s 型的按类型置空规则', (_label, draft, expected) => {
    expect(buildUpdateWatchRuleRequest(draft)).toMatchObject(expected);
  });

  test('update 载荷显式带上全部字段（null 而非省略）', () => {
    const body = buildUpdateWatchRuleRequest({ ...filled, triggerType: 'llm' });
    expect(Object.keys(body).sort()).toEqual([...PAYLOAD_KEYS].sort());
    expect(body).toEqual({
      name: 'spot check',
      triggerType: 'llm',
      pattern: null,
      patternFlags: '',
      extractGroup: 1,
      conditionPrompt: 'build finished?',
      providerId: 'p1',
      modelId: 'gpt-4o',
      confirmWithLlm: false,
      summarizeWithLlm: false,
      intervalSeconds: 45,
      unchangedMinutes: null,
      noMatchBehavior: 'ignore',
      fireMode: 'repeat',
      cooldownSeconds: 120,
    });
  });

  test('update 载荷不带 deviceId / paneId / enabled', () => {
    const body = buildUpdateWatchRuleRequest(filled) as Record<string, unknown>;
    expect('deviceId' in body).toBe(false);
    expect('paneId' in body).toBe(false);
    expect('enabled' in body).toBe(false);
  });

  test('create 载荷 = update 载荷 + deviceId / paneId / enabled', () => {
    const created = buildCreateWatchRuleRequest(filled, 'dev-1', 'pane-1');
    const expected: Record<string, unknown> = {
      ...buildUpdateWatchRuleRequest(filled),
      deviceId: 'dev-1',
      paneId: 'pane-1',
      enabled: true,
    };
    expect(created as unknown as Record<string, unknown>).toEqual(expected);
    expect(created.enabled).toBe(true);
  });

  test('跟随全局默认时 providerId 与 modelId 均为 null', () => {
    const body = buildUpdateWatchRuleRequest(
      draftWith({ name: 'rule', providerId: null, modelId: 'stale-model' })
    );
    expect(body.providerId).toBeNull();
    expect(body.modelId).toBeNull();
  });

  test('extractGroup 与 noMatchBehavior 对所有触发类型都原样提交', () => {
    for (const triggerType of TRIGGER_TYPES) {
      const body = buildUpdateWatchRuleRequest({
        ...filled,
        triggerType,
        extractGroup: 3,
        noMatchBehavior: 'ignore',
      });
      expect(body.extractGroup).toBe(3);
      expect(body.noMatchBehavior).toBe('ignore');
    }
  });
});

describe('buildAssistRegexRequest', () => {
  test('描述去空格并复用当前模型选择', () => {
    expect(
      buildAssistRegexRequest(
        draftWith({ providerId: 'p1', modelId: ' gpt-4o ' }),
        '  match download percentage  ',
        'dev-1',
        'pane-1'
      )
    ).toEqual({
      description: 'match download percentage',
      deviceId: 'dev-1',
      paneId: 'pane-1',
      providerId: 'p1',
      modelId: 'gpt-4o',
    });
  });

  test('未选供应商时 modelId 为 null', () => {
    expect(
      buildAssistRegexRequest(draftWith({ providerId: null, modelId: 'x' }), 'd', 'dev', 'pane')
    ).toMatchObject({ providerId: null, modelId: null });
  });
});
