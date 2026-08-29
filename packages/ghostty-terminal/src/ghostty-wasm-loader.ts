import type { GhosttyExports, LayoutMap } from './ghostty-wasm-abi';

// 跨打包器解析 wasm 资源：`new URL(rel, import.meta.url)` 是 Vite 推荐写法，Bun（运行/打包）
// 也支持，避免 `?url` 后缀只有 Vite 能解析、bun build 报无法 resolve 的问题。
const ghosttyWasmUrl = new URL('./assets/ghostty-vt.wasm', import.meta.url).href;

// `bun build --compile` 产物内，跨包引用的资产可能不进入嵌入表（实测 ENOENT）——
// 按 plan「无法可靠嵌入时的签名相邻资源」策略回退：`TMEX_GHOSTTY_WASM_PATH` 显式覆盖，
// 否则取可执行同目录的 `ghostty-vt.wasm`（managed 构建保证其随产物分发）。
function ghosttyWasmCandidates(): string[] {
  const candidates = [ghosttyWasmUrl];
  if (typeof Bun !== 'undefined' && typeof process !== 'undefined' && process.execPath) {
    const envPath = process.env.TMEX_GHOSTTY_WASM_PATH;
    if (envPath) {
      candidates.push(envPath);
    }
    const execDir = process.execPath.replace(/[/\\][^/\\]*$/, '');
    candidates.push(`${execDir}/ghostty-vt.wasm`);
  }
  return candidates;
}

async function loadGhosttyWasmBytes(source: string): Promise<ArrayBuffer> {
  const isFileUrl = source.startsWith('file://');
  const path = isFileUrl ? decodeURIComponent(new URL(source).pathname) : source;
  const isFilePath =
    isFileUrl ||
    path.startsWith('/') ||
    path.startsWith('./') ||
    path.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(path);

  if (isFilePath && typeof Bun !== 'undefined') {
    return Bun.file(path).arrayBuffer();
  }

  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`failed to load ghostty wasm: ${response.status} ${response.statusText}`);
  }

  return response.arrayBuffer();
}

async function loadGhosttyWasmBytesAny(): Promise<ArrayBuffer> {
  let lastError: unknown;
  for (const candidate of ghosttyWasmCandidates()) {
    try {
      return await loadGhosttyWasmBytes(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function instantiateGhosttyModule(): Promise<{
  exports: GhosttyExports;
  layout: LayoutMap;
}> {
  const wasmBytes = await loadGhosttyWasmBytesAny();
  const wasmModule = await WebAssembly.instantiate(wasmBytes, {
    env: {
      log() {
        // ignore wasm logs in production usage
      },
    },
  });

  const exports = wasmModule.instance.exports as GhosttyExports;
  const bytes = new Uint8Array(exports.memory.buffer);
  const typeJsonPtr = exports.ghostty_type_json();
  let end = typeJsonPtr;

  while (bytes[end] !== 0) {
    end += 1;
  }

  const layout = JSON.parse(
    new TextDecoder().decode(bytes.subarray(typeJsonPtr, end))
  ) as LayoutMap;

  return { exports, layout };
}
