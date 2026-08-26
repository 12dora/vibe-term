import { describe, expect, test } from 'bun:test';
import type { LanguageModel, LanguageModelMiddleware, ModelMessage, Tool } from 'ai';
import {
  MESSAGE_WINDOW_CHAR_BUDGET,
  applyMessageWindow,
  buildRunRequest,
  buildRunTools,
  resolveMaxStepsPerTurn,
} from './build-run-request';
import type { CreateTerminalToolsOptions, TerminalRuntimeLike } from './tools/terminal';

const dummyTool = { description: 'dummy' } as unknown as Tool;

function stubRuntime(): TerminalRuntimeLike {
  return {
    sendInput() {},
    async capturePaneText() {
      return '';
    },
    async getPaneInfo() {
      return {
        cols: 80,
        rows: 24,
        cursorX: 0,
        cursorY: 0,
        alternateScreen: false,
        currentCommand: 'bash',
      };
    },
  };
}

describe('applyMessageWindow', () => {
  test('预算内原样返回；无 user 超预算也原样返回', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ];
    expect(applyMessageWindow(messages, 10_000)).toBe(messages);
    const noUser: ModelMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(500) }] },
    ];
    expect(applyMessageWindow(noUser, 10)).toBe(noUser);
  });

  test('默认预算是 200_000', () => {
    expect(MESSAGE_WINDOW_CHAR_BUDGET).toBe(200_000);
  });
});

describe('resolveMaxStepsPerTurn', () => {
  test('至少 1', () => {
    expect(resolveMaxStepsPerTurn(25)).toBe(25);
    expect(resolveMaxStepsPerTurn(0)).toBe(1);
    expect(resolveMaxStepsPerTurn(-3)).toBe(1);
  });
});

describe('buildRunRequest', () => {
  test('string model 不 wrap；object model 注入 redaction middleware', () => {
    const wrapped: Array<{ model: unknown; middleware: unknown }> = [];
    const objectModel = { provider: 'mock', modelId: 'm' } as unknown as LanguageModel;
    const wrappedModel = { provider: 'wrapped' } as unknown as LanguageModel;
    const middleware = { specificationVersion: 'v3' } as LanguageModelMiddleware;

    const asString = buildRunRequest({
      messages: [{ role: 'user', content: 'hi' }],
      resolvedModel: 'openai/gpt-4.1',
      tools: { fetch_url: dummyTool },
      paneId: '%9',
      writeMode: 'auto',
      customSystemPrompt: 'extra-instructions',
      maxStepsPerTurn: 0,
      device: null,
      wrapModel: (args) => {
        wrapped.push(args);
        return wrappedModel;
      },
      createMiddleware: () => middleware,
    });
    expect(asString.model).toBe('openai/gpt-4.1');
    expect(wrapped).toEqual([]);
    expect(asString.system).toContain('pane %9');
    expect(asString.system).toContain('extra-instructions');
    expect(asString.providerOptions).toEqual({ openai: { store: false } });
    expect(typeof asString.stopWhen).toBe('function');
    expect(asString.tools.fetch_url).toBe(dummyTool);

    const asObject = buildRunRequest({
      messages: [{ role: 'user', content: 'hi' }],
      resolvedModel: objectModel,
      tools: {},
      paneId: '%1',
      writeMode: 'confirm',
      customSystemPrompt: null,
      maxStepsPerTurn: 8,
      device: null,
      wrapModel: (args) => {
        wrapped.push(args);
        return wrappedModel;
      },
      createMiddleware: () => middleware,
    });
    expect(asObject.model).toBe(wrappedModel);
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]?.model).toBe(objectModel);
    expect(wrapped[0]?.middleware).toBe(middleware);
  });

  test('超预算时对 messages 做 user 边界滑窗', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'x'.repeat(600) },
      { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: [{ type: 'text', text: 'new' }] },
    ];
    const built = buildRunRequest({
      messages,
      resolvedModel: 'mock/model',
      tools: {},
      paneId: null,
      writeMode: 'auto',
      customSystemPrompt: null,
      maxStepsPerTurn: 3,
      device: null,
      charBudget: 400,
      wrapModel: () => 'unused' as never,
    });
    expect(built.messages[0]).toBe(messages[2]);
    expect(built.messages).toEqual(messages.slice(2));
  });
});

describe('buildRunTools', () => {
  test('无 runtime 或 pane 时不建 terminal tools，始终带 fetch_url', async () => {
    let terminalCalls = 0;
    const fetchUrl = dummyTool;
    const tools = await buildRunTools({
      paneId: null,
      deviceId: 'dev',
      writeMode: 'auto',
      allowControlChars: false,
      useProviderWebSearch: false,
      providerId: null,
      providerHostedTools: [],
      runtime: stubRuntime(),
      getEmulator: () => null,
      onFailure: () => {},
      onSuccess: () => {},
      sleepMs: async () => {},
      resolveProviderWebSearchTool: async () => dummyTool,
      resolveProviderHostedTools: async () => ({ hosted: dummyTool }),
      createWebSearchTool: async () => dummyTool,
      createFetchUrlTool: () => fetchUrl,
      createTerminalTools: () => {
        terminalCalls += 1;
        return { read_screen: dummyTool };
      },
    });
    expect(terminalCalls).toBe(0);
    expect(tools.fetch_url).toBe(fetchUrl);
    expect(tools.read_screen).toBeUndefined();
    expect(tools.web_search).toBe(dummyTool);
  });

  test('runtime+pane 建 terminal tools，confirm 需要审批；provider 搜索与 hosted 合并', async () => {
    const runtime = stubRuntime();
    const captured: CreateTerminalToolsOptions[] = [];
    const providerSearch = dummyTool;
    const hosted = dummyTool;
    const tools = await buildRunTools({
      paneId: '%5',
      deviceId: 'dev',
      writeMode: 'confirm',
      allowControlChars: true,
      useProviderWebSearch: true,
      providerId: 'openai',
      providerHostedTools: ['image_generation'],
      runtime,
      getEmulator: () => null,
      onFailure: () => {},
      onSuccess: () => {},
      sleepMs: async () => {},
      resolveProviderWebSearchTool: async (providerId) => {
        expect(providerId).toBe('openai');
        return providerSearch;
      },
      resolveProviderHostedTools: async (_providerId, keys) => {
        expect([...keys]).toEqual(['image_generation']);
        return { image_generation: hosted };
      },
      createWebSearchTool: async () => {
        throw new Error('should not use local search');
      },
      createFetchUrlTool: () => dummyTool,
      createTerminalTools: (options) => {
        captured.push(options);
        return { read_screen: dummyTool };
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.paneId).toBe('%5');
    expect(captured[0]?.needsApprovalForWrite).toBe(true);
    expect(captured[0]?.allowControlChars).toBe(true);
    expect(captured[0]?.getRuntime()).toBe(runtime);
    expect(tools.web_search).toBe(providerSearch);
    expect(tools.image_generation).toBe(hosted);
    expect(tools.read_screen).toBe(dummyTool);
    expect(tools.fetch_url).toBe(dummyTool);
  });

  test('provider web search 返回 null 时不加 web_search', async () => {
    const tools = await buildRunTools({
      paneId: null,
      deviceId: null,
      writeMode: 'auto',
      allowControlChars: false,
      useProviderWebSearch: true,
      providerId: null,
      providerHostedTools: [],
      runtime: null,
      getEmulator: () => null,
      onFailure: () => {},
      onSuccess: () => {},
      sleepMs: async () => {},
      resolveProviderWebSearchTool: async () => null,
      resolveProviderHostedTools: async () => ({}),
      createWebSearchTool: async () => dummyTool,
      createFetchUrlTool: () => dummyTool,
      createTerminalTools: () => ({}),
    });
    expect(tools.web_search).toBeUndefined();
  });
});
