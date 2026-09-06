// 全局默认模型草稿的纯逻辑：换提供商时清理不属于它的模型、选模型时反向同步提供商、保存载荷。

import { describe, expect, test } from 'bun:test';
import type { LlmProviderDto } from '@tmex/shared';

import {
  type LlmDefaultsDraft,
  applyDefaultModel,
  applyDefaultProvider,
  buildDefaultsPayload,
} from './llm-defaults-state';

function provider(id: string, models: string[]): LlmProviderDto {
  return {
    id,
    name: id,
    protocol: 'openai-chat',
    baseUrl: 'https://example.test/v1',
    hasApiKey: true,
    enabled: true,
    models,
    modelDetails: [],
    modelsFetchedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const PROVIDERS = [provider('p1', ['alpha-1', 'alpha-2']), provider('p2', ['beta-1'])];

describe('applyDefaultProvider', () => {
  test('新提供商仍包含当前模型时保留模型', () => {
    const draft: LlmDefaultsDraft = { providerId: 'p1', modelId: 'alpha-2' };
    expect(applyDefaultProvider(draft, PROVIDERS, 'p1')).toEqual({
      providerId: 'p1',
      modelId: 'alpha-2',
    });
  });

  test('换到不含当前模型的提供商时清空模型', () => {
    const draft: LlmDefaultsDraft = { providerId: 'p1', modelId: 'alpha-2' };
    expect(applyDefaultProvider(draft, PROVIDERS, 'p2')).toEqual({
      providerId: 'p2',
      modelId: '',
    });
  });

  test('清空提供商时模型一并清空', () => {
    const draft: LlmDefaultsDraft = { providerId: 'p1', modelId: 'alpha-1' };
    expect(applyDefaultProvider(draft, PROVIDERS, null)).toEqual({
      providerId: null,
      modelId: '',
    });
  });
});

describe('applyDefaultModel', () => {
  test('选中模型同时写入提供商', () => {
    expect(applyDefaultModel({ providerId: 'p2', modelId: 'beta-1' })).toEqual({
      providerId: 'p2',
      modelId: 'beta-1',
    });
  });

  test('清空项两者同时清空', () => {
    expect(applyDefaultModel({ providerId: null, modelId: null })).toEqual({
      providerId: null,
      modelId: '',
    });
  });
});

describe('buildDefaultsPayload', () => {
  test('空模型序列化成 null，并去掉首尾空白', () => {
    expect(buildDefaultsPayload({ providerId: 'p1', modelId: '  ' })).toEqual({
      defaultProviderId: 'p1',
      defaultModelId: null,
    });
    expect(buildDefaultsPayload({ providerId: 'p1', modelId: ' alpha-1 ' })).toEqual({
      defaultProviderId: 'p1',
      defaultModelId: 'alpha-1',
    });
    expect(buildDefaultsPayload({ providerId: null, modelId: '' })).toEqual({
      defaultProviderId: null,
      defaultModelId: null,
    });
  });
});
