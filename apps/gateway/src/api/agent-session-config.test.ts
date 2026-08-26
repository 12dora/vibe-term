import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { ensureAgentSettingsInitialized, updateAgentSettings } from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { createLlmProvider } from '../db/llm';
import { t } from '../i18n';
import {
  type AgentSessionConfigExisting,
  type CreateAgentSessionConfig,
  parseAgentSessionConfig,
} from './agent-session-config';

let chatProviderId = '';
let responsesProviderId = '';

function existingSession(
  overrides: Partial<AgentSessionConfigExisting> = {}
): AgentSessionConfigExisting {
  return {
    providerId: null,
    modelId: 'mock-model',
    systemPrompt: null,
    writeMode: 'confirm',
    useProviderWebSearch: false,
    providerHostedTools: [],
    allowControlChars: false,
    maxStepsPerTurn: 25,
    ...overrides,
  };
}

function withSettings<T>(patch: Parameters<typeof updateAgentSettings>[0], fn: () => T): T {
  const prev = {
    defaultProviderId: null as string | null,
    defaultModelId: null as string | null,
  };
  const before = updateAgentSettings({});
  prev.defaultProviderId = before.defaultProviderId;
  prev.defaultModelId = before.defaultModelId;
  updateAgentSettings(patch);
  try {
    return fn();
  } finally {
    updateAgentSettings(prev);
  }
}

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  ensureAgentSettingsInitialized();
  chatProviderId = createLlmProvider({
    name: 'agent-config-chat',
    protocol: 'openai-chat',
    baseUrl: 'https://chat.example/v1',
    apiKeyEnc: 'enc',
    enabled: true,
  }).id;
  responsesProviderId = createLlmProvider({
    name: 'agent-config-responses',
    protocol: 'openai-responses',
    baseUrl: 'https://responses.example/v1',
    apiKeyEnc: 'enc',
    enabled: true,
  }).id;
});

describe('parseAgentSessionConfig — create（无 existing）', () => {
  const createCases: Array<
    {
      name: string;
      raw: Record<string, unknown>;
      settings?: Parameters<typeof updateAgentSettings>[0];
    } & ({ error: string } | { config: CreateAgentSessionConfig })
  > = [
    {
      name: '仅 modelId：provider 省略为 null，web-search/hosted/allow 默认，systemPrompt 默认 null',
      raw: { modelId: 'm' },
      config: {
        providerId: null,
        modelId: 'm',
        systemPrompt: null,
        useProviderWebSearch: false,
        providerHostedTools: [],
        allowControlChars: false,
      },
    },
    {
      name: 'modelId 省略且无全局默认 → llmNoDefaultModel',
      raw: {},
      settings: { defaultModelId: null },
      error: t('apiError.llmNoDefaultModel'),
    },
    {
      name: 'modelId 省略回退全局默认',
      raw: {},
      settings: { defaultModelId: 'default-model' },
      config: {
        providerId: null,
        modelId: 'default-model',
        systemPrompt: null,
        useProviderWebSearch: false,
        providerHostedTools: [],
        allowControlChars: false,
      },
    },
    {
      name: 'modelId 显式 null 与省略相同，回退默认',
      raw: { modelId: null },
      settings: { defaultModelId: 'from-null' },
      config: {
        providerId: null,
        modelId: 'from-null',
        systemPrompt: null,
        useProviderWebSearch: false,
        providerHostedTools: [],
        allowControlChars: false,
      },
    },
    {
      name: 'modelId 空字符串 → invalidRequest（不回退默认）',
      raw: { modelId: '' },
      settings: { defaultModelId: 'ignored' },
      error: t('apiError.invalidRequest'),
    },
    {
      name: 'modelId 空白 → invalidRequest',
      raw: { modelId: '  ' },
      error: t('apiError.invalidRequest'),
    },
    {
      name: 'modelId 非字符串 → invalidRequest',
      raw: { modelId: 1 },
      error: t('apiError.invalidRequest'),
    },
    {
      name: 'modelId 去空白',
      raw: { modelId: '  gpt-x  ' },
      config: {
        providerId: null,
        modelId: 'gpt-x',
        systemPrompt: null,
        useProviderWebSearch: false,
        providerHostedTools: [],
        allowControlChars: false,
      },
    },
    {
      name: 'providerId 省略与 null 都落成 null',
      raw: { modelId: 'm', providerId: null },
      config: {
        providerId: null,
        modelId: 'm',
        systemPrompt: null,
        useProviderWebSearch: false,
        providerHostedTools: [],
        allowControlChars: false,
      },
    },
    {
      name: 'providerId 不存在 → llmProviderNotFound',
      raw: { modelId: 'm', providerId: crypto.randomUUID() },
      error: t('apiError.llmProviderNotFound'),
    },
    {
      name: 'providerId 非字符串 → llmProviderNotFound',
      raw: { modelId: 'm', providerId: 1 },
      error: t('apiError.llmProviderNotFound'),
    },
    {
      name: 'writeMode 非法 → agentWriteModeInvalid',
      raw: { modelId: 'm', writeMode: 'yolo' },
      error: t('apiError.agentWriteModeInvalid'),
    },
    {
      name: 'writeMode 合法时出现在 config；省略时不出现（交给 DB 默认）',
      raw: { modelId: 'm', writeMode: 'auto' },
      config: {
        providerId: null,
        modelId: 'm',
        systemPrompt: null,
        writeMode: 'auto',
        useProviderWebSearch: false,
        providerHostedTools: [],
        allowControlChars: false,
      },
    },
    {
      name: 'useProviderWebSearch 非 boolean → invalidRequest',
      raw: { modelId: 'm', useProviderWebSearch: 'true' },
      error: t('apiError.invalidRequest'),
    },
    {
      name: 'useProviderWebSearch=true + openai-chat → 协议互斥',
      raw: { modelId: 'm', useProviderWebSearch: true },
      error: t('apiError.agentProviderWebSearchRequiresResponses'),
    },
    {
      name: 'maxStepsPerTurn 越界 0 / 101',
      raw: { modelId: 'm', maxStepsPerTurn: 0 },
      error: t('apiError.agentMaxStepsInvalid'),
    },
    {
      name: 'maxStepsPerTurn 101 → agentMaxStepsInvalid',
      raw: { modelId: 'm', maxStepsPerTurn: 101 },
      error: t('apiError.agentMaxStepsInvalid'),
    },
    {
      name: 'maxStepsPerTurn 合法且 Number 向下取整',
      raw: { modelId: 'm', maxStepsPerTurn: 10.9 },
      config: {
        providerId: null,
        modelId: 'm',
        systemPrompt: null,
        useProviderWebSearch: false,
        providerHostedTools: [],
        allowControlChars: false,
        maxStepsPerTurn: 10,
      },
    },
    {
      name: 'systemPrompt 非字符串非 null → invalidRequest',
      raw: { modelId: 'm', systemPrompt: 1 },
      error: t('apiError.invalidRequest'),
    },
    {
      name: 'systemPrompt 显式 null → config 为 null',
      raw: { modelId: 'm', systemPrompt: null },
      config: {
        providerId: null,
        modelId: 'm',
        systemPrompt: null,
        useProviderWebSearch: false,
        providerHostedTools: [],
        allowControlChars: false,
      },
    },
    {
      name: 'allowControlChars 非 boolean → invalidRequest',
      raw: { modelId: 'm', allowControlChars: 1 },
      error: t('apiError.invalidRequest'),
    },
    {
      name: 'providerHostedTools 非字符串数组 → invalidRequest',
      raw: { modelId: 'm', providerHostedTools: 'image_generation' },
      error: t('apiError.invalidRequest'),
    },
    {
      name: 'providerHostedTools 未知 key',
      raw: { modelId: 'm', providerHostedTools: ['nope'] },
      error: t('apiError.agentHostedToolUnknown', { name: 'nope' }),
    },
    {
      name: 'hosted tools 省略 → []，不出现 writeMode/maxSteps',
      raw: { modelId: 'm' },
      config: {
        providerId: null,
        modelId: 'm',
        systemPrompt: null,
        useProviderWebSearch: false,
        providerHostedTools: [],
        allowControlChars: false,
      },
    },
  ];

  for (const c of createCases) {
    test(c.name, () => {
      const run = () => parseAgentSessionConfig(c.raw);
      const result = c.settings ? withSettings(c.settings, run) : run();
      if ('error' in c) {
        expect(result).toEqual({ ok: false, error: c.error });
        return;
      }
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config).toEqual(c.config);
      }
    });
  }

  test('useProviderWebSearch=false + chat provider 可通过', () => {
    const result = parseAgentSessionConfig({
      modelId: 'm',
      providerId: chatProviderId,
      useProviderWebSearch: false,
    });
    expect(result).toEqual({
      ok: true,
      config: {
        providerId: chatProviderId,
        modelId: 'm',
        systemPrompt: null,
        useProviderWebSearch: false,
        providerHostedTools: [],
        allowControlChars: false,
      },
    });
  });

  test('useProviderWebSearch=true + responses provider 可通过', () => {
    const result = parseAgentSessionConfig({
      modelId: 'm',
      providerId: responsesProviderId,
      useProviderWebSearch: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.useProviderWebSearch).toBe(true);
      expect(result.config.providerId).toBe(responsesProviderId);
    }
  });

  test('useProviderWebSearch=true 且 provider 省略：回退默认 provider 协议', () => {
    const fail = withSettings({ defaultProviderId: chatProviderId, defaultModelId: 'm' }, () =>
      parseAgentSessionConfig({ useProviderWebSearch: true })
    );
    expect(fail).toEqual({
      ok: false,
      error: t('apiError.agentProviderWebSearchRequiresResponses'),
    });

    const ok = withSettings({ defaultProviderId: responsesProviderId, defaultModelId: 'm' }, () =>
      parseAgentSessionConfig({ useProviderWebSearch: true })
    );
    expect(ok.ok).toBe(true);
  });

  test('非空 hosted tools 要求 responses 协议', () => {
    const fail = parseAgentSessionConfig({
      modelId: 'm',
      providerId: chatProviderId,
      providerHostedTools: ['image_generation'],
    });
    expect(fail).toEqual({
      ok: false,
      error: t('apiError.agentHostedToolRequiresResponses'),
    });

    const ok = parseAgentSessionConfig({
      modelId: 'm',
      providerId: responsesProviderId,
      providerHostedTools: ['image_generation', 'image_generation', 'code_interpreter'],
    });
    expect(ok).toEqual({
      ok: true,
      config: {
        providerId: responsesProviderId,
        modelId: 'm',
        systemPrompt: null,
        useProviderWebSearch: false,
        providerHostedTools: ['image_generation', 'code_interpreter'],
        allowControlChars: false,
      },
    });
  });

  test('空 hosted tools 数组不要求 responses', () => {
    const result = parseAgentSessionConfig({
      modelId: 'm',
      providerId: chatProviderId,
      providerHostedTools: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.providerHostedTools).toEqual([]);
    }
  });
});

describe('parseAgentSessionConfig — update（有 existing）', () => {
  const existing = existingSession({
    providerId: null,
    modelId: 'keep-me',
    systemPrompt: 'old',
    useProviderWebSearch: false,
    providerHostedTools: ['image_generation'],
    allowControlChars: true,
    maxStepsPerTurn: 25,
  });

  test('空 patch：config 不含任何键（全部省略）', () => {
    const result = parseAgentSessionConfig({}, existing);
    expect(result).toEqual({ ok: true, config: {} });
  });

  test('providerId 省略不出现；null 显式清空', () => {
    const omitted = parseAgentSessionConfig({ writeMode: 'auto' }, existing);
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect('providerId' in omitted.config).toBe(false);
      expect(omitted.config.writeMode).toBe('auto');
    }

    const cleared = parseAgentSessionConfig({ providerId: null }, existing);
    expect(cleared).toEqual({ ok: true, config: { providerId: null } });
  });

  test('modelId 省略不出现；null 非法（与 create 不同）', () => {
    const omitted = parseAgentSessionConfig({}, existing);
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect('modelId' in omitted.config).toBe(false);
    }

    expect(parseAgentSessionConfig({ modelId: null }, existing)).toEqual({
      ok: false,
      error: t('apiError.invalidRequest'),
    });
    expect(parseAgentSessionConfig({ modelId: '' }, existing)).toEqual({
      ok: false,
      error: t('apiError.invalidRequest'),
    });
    expect(parseAgentSessionConfig({ modelId: '  next  ' }, existing)).toEqual({
      ok: true,
      config: { modelId: 'next' },
    });
  });

  test('systemPrompt 省略不出现；null 显式清空', () => {
    const omitted = parseAgentSessionConfig({}, existing);
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect('systemPrompt' in omitted.config).toBe(false);
    }
    expect(parseAgentSessionConfig({ systemPrompt: null }, existing)).toEqual({
      ok: true,
      config: { systemPrompt: null },
    });
    expect(parseAgentSessionConfig({ systemPrompt: 1 }, existing)).toEqual({
      ok: false,
      error: t('apiError.invalidRequest'),
    });
  });

  test('hosted tools 省略不覆盖 existing；显式 [] 会写入', () => {
    const omitted = parseAgentSessionConfig({ writeMode: 'confirm' }, existing);
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect('providerHostedTools' in omitted.config).toBe(false);
    }

    const cleared = parseAgentSessionConfig({ providerHostedTools: [] }, existing);
    expect(cleared).toEqual({ ok: true, config: { providerHostedTools: [] } });
  });

  test('只改 provider 为 chat、不带 hosted tools：不重验 hosted（现有行为）', () => {
    const withTools = existingSession({
      providerId: responsesProviderId,
      providerHostedTools: ['image_generation'],
    });
    const result = parseAgentSessionConfig({ providerId: chatProviderId }, withTools);
    expect(result).toEqual({ ok: true, config: { providerId: chatProviderId } });
  });

  test('PATCH 开启 web-search：按合成后的 provider 验协议', () => {
    const chatExisting = existingSession({ providerId: chatProviderId });
    expect(parseAgentSessionConfig({ useProviderWebSearch: true }, chatExisting)).toEqual({
      ok: false,
      error: t('apiError.agentProviderWebSearchRequiresResponses'),
    });

    expect(
      parseAgentSessionConfig(
        { providerId: responsesProviderId, useProviderWebSearch: true },
        chatExisting
      )
    ).toEqual({
      ok: true,
      config: { providerId: responsesProviderId, useProviderWebSearch: true },
    });
  });

  test('existing 已开 web-search：任意 PATCH 都用合成 provider 再验', () => {
    const searching = existingSession({
      providerId: responsesProviderId,
      useProviderWebSearch: true,
    });
    expect(parseAgentSessionConfig({ title: 'x' }, searching)).toEqual({
      ok: true,
      config: {},
    });
    expect(parseAgentSessionConfig({ providerId: chatProviderId }, searching)).toEqual({
      ok: false,
      error: t('apiError.agentProviderWebSearchRequiresResponses'),
    });
    expect(parseAgentSessionConfig({ useProviderWebSearch: false }, searching)).toEqual({
      ok: true,
      config: { useProviderWebSearch: false },
    });
    expect(parseAgentSessionConfig({ providerId: null }, searching)).toEqual({
      ok: false,
      error: t('apiError.agentProviderWebSearchRequiresResponses'),
    });
  });

  test('useProviderWebSearch 非 boolean / writeMode 非法 / maxSteps 越界', () => {
    expect(parseAgentSessionConfig({ useProviderWebSearch: 'yes' }, existing)).toEqual({
      ok: false,
      error: t('apiError.invalidRequest'),
    });
    expect(parseAgentSessionConfig({ writeMode: 'x' }, existing)).toEqual({
      ok: false,
      error: t('apiError.agentWriteModeInvalid'),
    });
    expect(parseAgentSessionConfig({ maxStepsPerTurn: 1000 }, existing)).toEqual({
      ok: false,
      error: t('apiError.agentMaxStepsInvalid'),
    });
    expect(parseAgentSessionConfig({ maxStepsPerTurn: 1 }, existing)).toEqual({
      ok: true,
      config: { maxStepsPerTurn: 1 },
    });
  });

  test('allowControlChars 省略不出现；显式 false 写入', () => {
    const omitted = parseAgentSessionConfig({}, existing);
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect('allowControlChars' in omitted.config).toBe(false);
    }
    expect(parseAgentSessionConfig({ allowControlChars: false }, existing)).toEqual({
      ok: true,
      config: { allowControlChars: false },
    });
  });
});
