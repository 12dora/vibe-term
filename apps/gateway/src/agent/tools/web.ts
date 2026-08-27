// Web 工具：web_search（tavily/brave 分发）与 fetch_url（含 SSRF 防护）

import { type Tool, tool } from 'ai';
import { z } from 'zod';
import { decrypt } from '../../crypto';
import { type AgentSettingsRecord, getAgentSettings } from '../../db/agent';
import { isCanonicalIpv4, isPrivateIpv4, isPrivateIpv6Bytes, parseIpv6ToBytes } from './ip-address';
import { wrapUntrusted } from './untrusted';

const WEB_SEARCH_MAX_RESULTS = 8;
const WEB_SEARCH_RESULT_MAX_BYTES = 8 * 1024;
const FETCH_URL_TIMEOUT_MS = 15_000;
const FETCH_URL_MAX_BODY_BYTES = 2 * 1024 * 1024;
const FETCH_URL_TEXT_MAX_BYTES = 16 * 1024;
const FETCH_URL_MAX_REDIRECTS = 3;

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) {
    return text;
  }
  let result = text;
  // 二分收敛到字节上限，避免逐字符循环
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  result = text.slice(0, low);
  return `${result}\n[truncated]`;
}

// ========== SSRF 防护 ==========

function normalizeHostname(hostname: string): string {
  let value = hostname.toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  return value;
}

// 数字形式 host（十进制/0x 十六进制/前导零八进制段，1-4 段）：
// 非规范点分四段时是 IPv4 字面量的混淆写法（如 2130706433、127.1、0177.0.0.1、0x7f000001）
function isNumericHost(host: string): boolean {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) {
    return false;
  }
  return parts.every((part) => /^(0x[0-9a-f]+|\d+)$/.test(part));
}

export function isPrivateHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }

  if (isCanonicalIpv4(host)) {
    const octets = host.split('.').map(Number);
    return isPrivateIpv4(octets[0] ?? 0, octets[1] ?? 0);
  }

  // 非规范数字形式（整数 IP、缺段、八进制/十六进制段）一律拒绝：
  // 正常网站不会用这种 host，放行只会留下绕过私网判断的口子
  if (isNumericHost(host)) {
    return true;
  }

  // IPv6（URL.hostname 对 IPv6 字面量返回带括号形式，已剥除）
  if (host.includes(':')) {
    const bytes = parseIpv6ToBytes(host);
    if (!bytes) return true;
    return isPrivateIpv6Bytes(bytes);
  }

  return false;
}

function allowPrivateFetch(): boolean {
  return process.env.TMEX_AGENT_ALLOW_PRIVATE_FETCH === '1';
}

export function validateFetchUrl(rawUrl: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: `Invalid URL: ${rawUrl}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `Unsupported protocol: ${url.protocol} (only http/https are allowed)` };
  }
  if (!allowPrivateFetch() && isPrivateHostname(url.hostname)) {
    return { error: `Refusing to fetch private/internal address: ${url.hostname}` };
  }
  return { url };
}

// ========== web_search ==========

/** search() 的运行期注入（测试替身 / endpoint 覆盖）；缺省用全局 fetch 与 provider 默认 endpoint */
export interface SearchProviderDeps {
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

/** 搜索 provider 抽象：注册进模块级 registry，按 agentSettings.searchProvider 查找。
 * provider 拿完整 settings 自行取所需凭证（内建 tavily/brave 读各自的 *ApiKeyEnc 列）。 */
export interface SearchProvider {
  readonly id: string;
  readonly label: string;
  isConfigured(settings: AgentSettingsRecord): boolean;
  search(
    query: string,
    settings: AgentSettingsRecord,
    deps?: SearchProviderDeps
  ): Promise<WebSearchResultItem[]>;
}

const searchProviderRegistry = new Map<string, SearchProvider>();

/** 注册搜索 provider；重复 id 视为编程错误，直接抛错 */
export function registerSearchProvider(provider: SearchProvider): void {
  if (searchProviderRegistry.has(provider.id)) {
    throw new Error(`search provider already registered: ${provider.id}`);
  }
  searchProviderRegistry.set(provider.id, provider);
}

/** 按注册顺序返回全部 provider */
export function getSearchProviders(): SearchProvider[] {
  return [...searchProviderRegistry.values()];
}

export function getSearchProvider(id: string): SearchProvider | undefined {
  return searchProviderRegistry.get(id);
}

const TAVILY_DEFAULT_ENDPOINT = 'https://api.tavily.com/search';
const BRAVE_DEFAULT_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

const tavilyProvider: SearchProvider = {
  id: 'tavily',
  label: 'Tavily',
  isConfigured: (settings) => Boolean(settings.tavilyApiKeyEnc),
  async search(query, settings, deps) {
    const apiKey = await decrypt(settings.tavilyApiKeyEnc ?? '');
    const fetchImpl = deps?.fetchImpl ?? fetch;
    const endpoint = deps?.endpoint ?? TAVILY_DEFAULT_ENDPOINT;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Tavily 现行 API 使用 Bearer header，旧版接受 body api_key；两者都带以兼容
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: WEB_SEARCH_MAX_RESULTS,
      }),
      signal: AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Tavily search failed: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return (payload.results ?? []).map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.content ?? '',
    }));
  },
};

const braveProvider: SearchProvider = {
  id: 'brave',
  label: 'Brave',
  isConfigured: (settings) => Boolean(settings.braveApiKeyEnc),
  async search(query, settings, deps) {
    const apiKey = await decrypt(settings.braveApiKeyEnc ?? '');
    const fetchImpl = deps?.fetchImpl ?? fetch;
    const url = new URL(deps?.endpoint ?? BRAVE_DEFAULT_ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(WEB_SEARCH_MAX_RESULTS));
    const response = await fetchImpl(url.toString(), {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Brave search failed: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (payload.web?.results ?? []).map((item) => ({
      title: item.title ?? '',
      url: item.url ?? '',
      snippet: item.description ?? '',
    }));
  },
};

registerSearchProvider(tavilyProvider);
registerSearchProvider(braveProvider);

export interface CreateWebSearchToolOptions {
  settings?: AgentSettingsRecord;
  fetchImpl?: typeof fetch;
  /** 按 provider id 覆盖 endpoint（测试注入） */
  endpointOverrides?: Record<string, string>;
  /** 兼容旧签名的内建 endpoint 覆盖 */
  tavilyEndpoint?: string;
  braveEndpoint?: string;
}

/** searchProvider='none'、provider 未注册或未配置凭证时返回 null（不注册工具） */
export async function createWebSearchTool(
  options: CreateWebSearchToolOptions = {}
): Promise<Tool | null> {
  const settings = options.settings ?? getAgentSettings();
  if (settings.searchProvider === 'none') {
    return null;
  }

  const provider = searchProviderRegistry.get(settings.searchProvider);
  if (!provider || !provider.isConfigured(settings)) {
    return null;
  }

  const endpoint =
    options.endpointOverrides?.[provider.id] ??
    (provider.id === 'tavily'
      ? options.tavilyEndpoint
      : provider.id === 'brave'
        ? options.braveEndpoint
        : undefined);
  const deps: SearchProviderDeps = {
    fetchImpl: options.fetchImpl ?? fetch,
    endpoint,
  };

  const searchFn = (query: string) => provider.search(query, settings, deps);
  return tool({
    description: 'Search the web. Returns a JSON array of results with title, url and snippet.',
    inputSchema: z.object({
      query: z.string().min(1).describe('The search query.'),
    }),
    execute: async ({ query }) => {
      try {
        const results = await searchFn(query);
        return truncateUtf8(JSON.stringify(results), WEB_SEARCH_RESULT_MAX_BYTES);
      } catch (error) {
        return `Web search failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}

// ========== fetch_url ==========

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const remaining = merged.length - offset;
    if (remaining <= 0) break;
    merged.set(chunk.subarray(0, Math.min(chunk.length, remaining)), offset);
    offset += Math.min(chunk.length, remaining);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

const STRIP_ELEMENT_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'nav',
  'header',
  'footer',
  'aside',
  'iframe',
];

async function extractHtmlText(html: string): Promise<string> {
  let rewriter = new HTMLRewriter();
  for (const selector of STRIP_ELEMENT_SELECTORS) {
    rewriter = rewriter.on(selector, {
      element(element) {
        element.remove();
      },
    });
  }
  const cleaned = await rewriter.transform(new Response(html)).text();
  return cleaned
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/(?:[ \t]*\n[ \t]*){2,}/g, '\n\n')
    .trim();
}

export interface CreateFetchUrlToolOptions {
  fetchImpl?: typeof fetch;
}

export function createFetchUrlTool(options: CreateFetchUrlToolOptions = {}): Tool {
  const fetchImpl = options.fetchImpl ?? fetch;

  return tool({
    description:
      'Fetch a public http/https URL and return its readable text content (HTML is converted to plain text).',
    inputSchema: z.object({
      url: z.string().min(1).describe('The absolute http/https URL to fetch.'),
    }),
    execute: async ({ url: rawUrl }) => {
      let currentUrl = rawUrl;
      try {
        for (let redirects = 0; redirects <= FETCH_URL_MAX_REDIRECTS; redirects++) {
          const validated = validateFetchUrl(currentUrl);
          if ('error' in validated) {
            return validated.error;
          }

          const response = await fetchImpl(validated.url.toString(), {
            redirect: 'manual',
            signal: AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
            headers: { Accept: 'text/html,application/xhtml+xml,text/plain,*/*' },
          });

          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) {
              return `Fetch failed: HTTP ${response.status} redirect without Location header`;
            }
            currentUrl = new URL(location, validated.url).toString();
            continue;
          }

          if (!response.ok) {
            return `Fetch failed: HTTP ${response.status}`;
          }

          const contentType = response.headers.get('content-type') ?? '';
          const body = await readBodyWithLimit(response, FETCH_URL_MAX_BODY_BYTES);

          if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
            const text = await extractHtmlText(body);
            return wrapUntrusted(truncateUtf8(text, FETCH_URL_TEXT_MAX_BYTES), 'web');
          }

          return wrapUntrusted(truncateUtf8(body, FETCH_URL_TEXT_MAX_BYTES), 'web');
        }
        return `Fetch failed: too many redirects (>${FETCH_URL_MAX_REDIRECTS})`;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          return `Fetch failed: timeout after ${FETCH_URL_TIMEOUT_MS}ms`;
        }
        return `Fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
