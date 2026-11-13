import { describe, expect, test } from 'bun:test';
import { apiKeyRequiredOnEdit } from './llm-provider-form';

const provider = { baseUrl: 'https://llm.example.com/v1', protocol: 'openai-chat' as const };

describe('apiKeyRequiredOnEdit', () => {
  test('地址与协议都没动：留空即沿用已存的 Key', () => {
    expect(apiKeyRequiredOnEdit(provider, { ...provider })).toBe(false);
    const padded = { baseUrl: ' https://llm.example.com/v1 ', protocol: provider.protocol };
    expect(apiKeyRequiredOnEdit(provider, padded)).toBe(false);
  });

  test('改了接口地址：必须重新输入 Key，不能把已存的 Key 发给新目标', () => {
    const moved = { baseUrl: 'https://other.example.com/v1', protocol: provider.protocol };
    expect(apiKeyRequiredOnEdit(provider, moved)).toBe(true);
  });

  test('改了协议同样必须重新输入 Key', () => {
    const switched = { baseUrl: provider.baseUrl, protocol: 'openai-responses' as const };
    expect(apiKeyRequiredOnEdit(provider, switched)).toBe(true);
  });
});
