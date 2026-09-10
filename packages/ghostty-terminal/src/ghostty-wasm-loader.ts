// ghostty-vt.wasm 的定位与实例化。从 ghostty-wasm.ts 拆出来：那边是 FFI/内存所有权边界，
// 不该再混进资源加载的多宿主分支（浏览器 fetch / Bun 文件 / --compile 相邻资源）。
//
// 定位与实例化刻意分两步：候选列表只解决「文件在哪」，一旦某个候选拿到了字节/响应就定下来；
// 之后的实例化失败是真失败（wasm 损坏、导入不匹配），不该退化成继续试下一个候选。

// 跨打包器解析 wasm 资源：`new URL(rel, import.meta.url)` 是 Vite 推荐写法，Bun（运行/打包）
// 也支持，避免 `?url` 后缀只有 Vite 能解析、bun build 报无法 resolve 的问题。
const ghosttyWasmUrl = new URL('./assets/ghostty-vt.wasm', import.meta.url).href;

const WASM_CONTENT_TYPE = 'application/wasm';

type ResolvedWasm =
  | { kind: 'bytes'; bytes: ArrayBuffer }
  | { kind: 'response'; url: string; response: Response };

// `bun build --compile` 产物内，跨包引用的资产可能不进入嵌入表（实测 ENOENT）——
// 按 plan「无法可靠嵌入时的签名相邻资源」策略回退：`VIBETERM_GHOSTTY_WASM_PATH` 显式覆盖，
// 否则取可执行同目录的 `ghostty-vt.wasm`（managed 构建保证其随产物分发）。
export function ghosttyWasmCandidates(): string[] {
  const candidates = [ghosttyWasmUrl];
  if (typeof Bun !== 'undefined' && typeof process !== 'undefined' && process.execPath) {
    const envPath = process.env.VIBETERM_GHOSTTY_WASM_PATH;
    if (envPath) {
      candidates.push(envPath);
    }
    const execDir = process.execPath.replace(/[/\\][^/\\]*$/, '');
    candidates.push(`${execDir}/ghostty-vt.wasm`);
  }
  return candidates;
}

function isLocalFileSource(source: string): boolean {
  return (
    source.startsWith('file://') ||
    source.startsWith('/') ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(source)
  );
}

function toFilePath(source: string): string {
  return source.startsWith('file://') ? decodeURIComponent(new URL(source).pathname) : source;
}

async function fetchWasm(source: string): Promise<Response> {
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`failed to load ghostty wasm: ${response.status} ${response.statusText}`);
  }
  return response;
}

/** 只负责「拿到内容」：本地文件走 Bun 直读，其余走网络。失败即视为该候选不可用。 */
export async function openWasmSource(source: string): Promise<ResolvedWasm> {
  if (isLocalFileSource(source) && typeof Bun !== 'undefined') {
    return { kind: 'bytes', bytes: await Bun.file(toFilePath(source)).arrayBuffer() };
  }
  return { kind: 'response', url: source, response: await fetchWasm(source) };
}

/** instantiateStreaming 严格校验 MIME：只有服务端确实按 application/wasm 下发时才走流式 */
function canStream(response: Response): boolean {
  if (typeof WebAssembly.instantiateStreaming !== 'function') return false;
  return (response.headers.get('Content-Type') ?? '').toLowerCase().startsWith(WASM_CONTENT_TYPE);
}

export async function instantiateResolvedWasm(
  resolved: ResolvedWasm,
  imports: WebAssembly.Imports
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  if (resolved.kind === 'bytes') {
    return WebAssembly.instantiate(resolved.bytes, imports);
  }
  if (!canStream(resolved.response)) {
    return WebAssembly.instantiate(await resolved.response.arrayBuffer(), imports);
  }
  try {
    // 边下边编译：省掉一次 555 KB 的整包 arrayBuffer 与随后的串行编译
    return await WebAssembly.instantiateStreaming(resolved.response, imports);
  } catch {
    // 流式失败（响应被中途截断、代理重写等冷路径）：整包重取一次兜底
    const retry = await fetchWasm(resolved.url);
    return WebAssembly.instantiate(await retry.arrayBuffer(), imports);
  }
}

/** 单个源的完整加载路径，供测试直接驱动 */
export async function instantiateWasmSource(
  source: string,
  imports: WebAssembly.Imports
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  return instantiateResolvedWasm(await openWasmSource(source), imports);
}

async function resolveGhosttyWasm(): Promise<ResolvedWasm> {
  let lastError: unknown;
  for (const candidate of ghosttyWasmCandidates()) {
    try {
      return await openWasmSource(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function instantiateGhosttyWasm(
  imports: WebAssembly.Imports
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  return instantiateResolvedWasm(await resolveGhosttyWasm(), imports);
}
