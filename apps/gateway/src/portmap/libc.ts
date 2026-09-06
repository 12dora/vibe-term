import { createRequire } from 'node:module';

/**
 * `bun:ffi` 取 libc 符号的共用入口，加载方式与 `log/rotate.ts` 的 dup2 一致：
 * macOS 用 `libSystem.B.dylib`，Linux 依次试 glibc / musl 的 so 名，取不到就返回 null 由调用方降级。
 */
export type LibcSignature = Record<string, { args: unknown[]; returns: unknown }>;
export type LibcSymbol = (...args: never[]) => number;
export type Libc = {
  symbols: Record<string, LibcSymbol>;
  ptr: (view: ArrayBufferView) => number;
};

type FfiModule = {
  dlopen: (path: string, symbols: LibcSignature) => { symbols: Record<string, LibcSymbol> };
  FFIType: Record<string, unknown>;
  ptr: (view: ArrayBufferView) => number;
};

const CANDIDATES =
  process.platform === 'darwin'
    ? ['/usr/lib/libSystem.B.dylib']
    : ['libc.so.6', 'libc.so', `libc.musl-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`];

let ffi: FfiModule | null | undefined;

function ffiModule(): FfiModule | null {
  if (ffi === undefined) {
    try {
      ffi = createRequire(import.meta.url)('bun:ffi') as FfiModule;
    } catch {
      ffi = null;
    }
  }
  return ffi;
}

export function openLibc(build: (types: Record<string, unknown>) => LibcSignature): Libc | null {
  const mod = ffiModule();
  if (!mod) return null;
  const signature = build(mod.FFIType);
  for (const path of CANDIDATES) {
    try {
      return { symbols: mod.dlopen(path, signature).symbols, ptr: mod.ptr };
    } catch {
      // 换下一个候选
    }
  }
  return null;
}
