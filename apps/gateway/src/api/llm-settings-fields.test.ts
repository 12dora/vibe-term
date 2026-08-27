import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb as getOrmDb } from '../db/client';
import { createLlmProvider } from '../db/llm';
import { t } from '../i18n';
import { parseUpdateSettingsFields } from './llm-settings-fields';

let providerId = '';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  providerId = createLlmProvider({
    name: 'settings-field-provider',
    protocol: 'openai-chat',
    baseUrl: 'https://settings.example/v1',
    apiKeyEnc: 'enc',
    enabled: true,
  }).id;
});

describe('parseUpdateSettingsFields', () => {
  test('空 body → 空 fields', () => {
    expect(parseUpdateSettingsFields({})).toEqual({ ok: true, fields: {} });
  });

  test('合法 searchProvider / 默认模型透传', () => {
    expect(
      parseUpdateSettingsFields({
        searchProvider: 'tavily',
        defaultProviderId: providerId,
        defaultModelId: 'model-a',
        tavilyApiKey: '  tvly  ',
        braveApiKey: '  brave  ',
      })
    ).toEqual({
      ok: true,
      fields: {
        searchProvider: 'tavily',
        defaultProviderId: providerId,
        defaultModelId: 'model-a',
        tavilyApiKey: 'tvly',
        braveApiKey: 'brave',
      },
    });
  });

  test('searchProvider none 合法；未知 id 非法', () => {
    expect(parseUpdateSettingsFields({ searchProvider: 'none' })).toEqual({
      ok: true,
      fields: { searchProvider: 'none' },
    });
    expect(parseUpdateSettingsFields({ searchProvider: 'google' })).toEqual({
      ok: false,
      error: t('apiError.llmSearchProviderInvalid'),
    });
  });

  test('defaultProviderId null 清空；未知 id 报 llmDefaultProviderNotFound', () => {
    expect(parseUpdateSettingsFields({ defaultProviderId: null })).toEqual({
      ok: true,
      fields: { defaultProviderId: null },
    });
    expect(parseUpdateSettingsFields({ defaultProviderId: crypto.randomUUID() })).toEqual({
      ok: false,
      error: t('apiError.llmDefaultProviderNotFound'),
    });
  });

  test('defaultModelId null 合法', () => {
    expect(parseUpdateSettingsFields({ defaultModelId: null })).toEqual({
      ok: true,
      fields: { defaultModelId: null },
    });
  });

  test('空串 search key 保留为空串（调用方负责 clear）', () => {
    expect(parseUpdateSettingsFields({ tavilyApiKey: '   ', braveApiKey: '' })).toEqual({
      ok: true,
      fields: { tavilyApiKey: '', braveApiKey: '' },
    });
  });

  test('searchProvider 非字符串 → llmSearchProviderInvalid', () => {
    expect(parseUpdateSettingsFields({ searchProvider: 1 })).toEqual({
      ok: false,
      error: t('apiError.llmSearchProviderInvalid'),
    });
  });

  const invalidCases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: 'defaultProviderId 非字符串非 null', body: { defaultProviderId: 1 } },
    { name: 'defaultModelId 非字符串非 null', body: { defaultModelId: 1 } },
    { name: 'tavilyApiKey 非字符串', body: { tavilyApiKey: 1 } },
    { name: 'braveApiKey 非字符串', body: { braveApiKey: true } },
  ];

  for (const { name, body } of invalidCases) {
    test(name, () => {
      expect(parseUpdateSettingsFields(body)).toEqual({
        ok: false,
        error: t('apiError.invalidRequest'),
      });
    });
  }
});
