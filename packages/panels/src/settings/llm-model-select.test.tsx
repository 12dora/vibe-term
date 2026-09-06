// 模型选择器：分组来源（仅启用且有模型的提供商）、选中值还原成 provider+model、
// 停用模型的占位显示与空态禁用。弹层走 portal，无 DOM 环境只能静态渲染触发器。

import { describe, expect, test } from 'bun:test';
import type { LlmProviderDto } from '@tmex/shared';
import { I18N_RESOURCES } from '@tmex/shared';
import i18next from 'i18next';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

import { encodeModelValue } from '../agent/model-value';
import {
  LlmModelSelect,
  NONE_MODEL_VALUE,
  buildLlmModelGroups,
  isModelSelectable,
  resolveModelSelection,
} from './llm-model-select';

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function provider(overrides: Partial<LlmProviderDto> & { id: string }): LlmProviderDto {
  return {
    name: overrides.id,
    protocol: 'openai-chat',
    baseUrl: 'https://example.test/v1',
    hasApiKey: true,
    enabled: true,
    models: [],
    modelDetails: [],
    modelsFetchedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const PROVIDERS: LlmProviderDto[] = [
  provider({ id: 'p1', name: 'Alpha', models: ['alpha-1', 'alpha-2'] }),
  provider({ id: 'p2', name: 'Beta', models: ['beta-1'] }),
  provider({ id: 'p3', name: 'Disabled', models: ['gamma-1'], enabled: false }),
  provider({ id: 'p4', name: 'NoModels', models: [] }),
];

function render(node: ReactElement): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

describe('buildLlmModelGroups', () => {
  test('只保留启用且有模型的提供商，按提供商分组', () => {
    expect(buildLlmModelGroups(PROVIDERS)).toEqual([
      { providerId: 'p1', providerName: 'Alpha', models: ['alpha-1', 'alpha-2'] },
      { providerId: 'p2', providerName: 'Beta', models: ['beta-1'] },
    ]);
  });

  test('没有可用模型时为空', () => {
    expect(buildLlmModelGroups([provider({ id: 'p4' })])).toEqual([]);
  });
});

describe('isModelSelectable', () => {
  const groups = buildLlmModelGroups(PROVIDERS);

  test('模型必须属于对应提供商才算可选', () => {
    expect(isModelSelectable(groups, 'p1', 'alpha-2')).toBe(true);
    expect(isModelSelectable(groups, 'p2', 'alpha-2')).toBe(false);
    expect(isModelSelectable(groups, 'p3', 'gamma-1')).toBe(false);
    expect(isModelSelectable(groups, null, 'alpha-1')).toBe(false);
    expect(isModelSelectable(groups, 'p1', null)).toBe(false);
  });
});

describe('resolveModelSelection', () => {
  test('选中模型同时得到 providerId 与 modelId', () => {
    expect(resolveModelSelection(encodeModelValue('p2', 'beta-1'))).toEqual({
      providerId: 'p2',
      modelId: 'beta-1',
    });
  });

  test('none 项清空两者', () => {
    expect(resolveModelSelection(NONE_MODEL_VALUE)).toEqual({
      providerId: null,
      modelId: null,
    });
  });
});

describe('LlmModelSelect 触发器', () => {
  test('选中可用模型时显示模型 ID', () => {
    const html = render(
      <LlmModelSelect
        providers={PROVIDERS}
        providerId="p1"
        modelId="alpha-2"
        onChange={() => undefined}
        testId="model-select"
      />
    );
    expect(html).toContain('alpha-2');
    expect(html).not.toContain('已停用');
    expect(html).toContain(`value="${encodeModelValue('p1', 'alpha-2')}"`);
    expect(html).not.toContain('disabled=""');
  });

  test('模型已被停用时仍显示存量值并标注', () => {
    const html = render(
      <LlmModelSelect
        providers={PROVIDERS}
        providerId="p3"
        modelId="gamma-1"
        onChange={() => undefined}
        testId="model-select"
      />
    );
    expect(html).toContain('gamma-1（已停用）');
  });

  test('无可用模型时禁用并提示先启用模型', () => {
    const html = render(
      <LlmModelSelect
        providers={[provider({ id: 'p4' })]}
        providerId={null}
        modelId={null}
        onChange={() => undefined}
        testId="model-select"
      />
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain('无可用模型，请先在提供商中启用模型');
  });

  test('未选模型且允许留空时显示 none 文案', () => {
    const html = render(
      <LlmModelSelect
        providers={PROVIDERS}
        providerId={null}
        modelId={null}
        onChange={() => undefined}
        allowNone
        noneLabel="跟随全局默认"
        testId="model-select"
      />
    );
    expect(html).toContain('跟随全局默认');
    expect(html).not.toContain('disabled=""');
  });
});
