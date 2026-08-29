import type { GhosttyBindings } from './ghostty-wasm';
import type { GhosttyColorRgb, GhosttyRenderSnapshotMeta } from './types';

const GHOSTTY_SUCCESS = 0;
const GHOSTTY_INVALID_VALUE = -2;

export type GhosttyRenderStateResources = {
  bindings: GhosttyBindings;
  renderStateHandle: number;
  rowIteratorHandle: number;
  rowCellsHandle: number;
  snapshotVersion: number;
  disposed: boolean;
  cachedMeta: GhosttyRenderSnapshotMeta | null;
};

export type RenderStateRead = (ptr: number) => number;

export function readColorAt(bindings: GhosttyBindings, ptr: number): GhosttyColorRgb {
  return {
    r: bindings.view().getUint8(ptr),
    g: bindings.view().getUint8(ptr + 1),
    b: bindings.view().getUint8(ptr + 2),
  };
}

export function readOptionalColor(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number
): GhosttyColorRgb | null {
  const color = resources.bindings.allocStruct('GhosttyColorRgb');

  try {
    const result = read(color.ptr);
    if (result === GHOSTTY_INVALID_VALUE) {
      return null;
    }

    if (result !== GHOSTTY_SUCCESS) {
      throw new Error(`ghostty optional color read failed with result ${result}`);
    }

    return readColorAt(resources.bindings, color.ptr);
  } finally {
    color.free();
  }
}

export function readBool(resources: GhosttyRenderStateResources, read: RenderStateRead): boolean {
  const ptr = resources.bindings.allocU8();

  try {
    const result = read(ptr);
    if (result !== GHOSTTY_SUCCESS) {
      throw new Error(`ghostty bool read failed with result ${result}`);
    }

    return resources.bindings.readU8(ptr) !== 0;
  } finally {
    resources.bindings.freeU8(ptr);
  }
}

export function readU16(resources: GhosttyRenderStateResources, read: RenderStateRead): number {
  const ptr = resources.bindings.allocBytes(2);

  try {
    const result = read(ptr);
    if (result !== GHOSTTY_SUCCESS) {
      throw new Error(`ghostty u16 read failed with result ${result}`);
    }

    return resources.bindings.view().getUint16(ptr, true);
  } finally {
    resources.bindings.freeBytes(ptr, 2);
  }
}

export function readU32(resources: GhosttyRenderStateResources, read: RenderStateRead): number {
  const ptr = resources.bindings.allocBytes(4);

  try {
    const result = read(ptr);
    if (result !== GHOSTTY_SUCCESS) {
      throw new Error(`ghostty u32 read failed with result ${result}`);
    }

    return resources.bindings.view().getUint32(ptr, true);
  } finally {
    resources.bindings.freeBytes(ptr, 4);
  }
}

export function readEnumI32(resources: GhosttyRenderStateResources, read: RenderStateRead): number {
  const ptr = resources.bindings.allocBytes(4);

  try {
    const result = read(ptr);
    if (result !== GHOSTTY_SUCCESS) {
      throw new Error(`ghostty enum read failed with result ${result}`);
    }

    return resources.bindings.view().getInt32(ptr, true);
  } finally {
    resources.bindings.freeBytes(ptr, 4);
  }
}

export function readU64(resources: GhosttyRenderStateResources, read: RenderStateRead): bigint {
  const ptr = resources.bindings.allocBytes(8);

  try {
    const result = read(ptr);
    if (result !== GHOSTTY_SUCCESS) {
      throw new Error(`ghostty u64 read failed with result ${result}`);
    }

    return resources.bindings.readU64(ptr);
  } finally {
    resources.bindings.freeBytes(ptr, 8);
  }
}
