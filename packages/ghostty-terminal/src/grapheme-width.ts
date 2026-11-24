import type { GhosttyBindings } from './ghostty-wasm';
import {
  type GhosttyRenderStateResources,
  createRenderState,
  disposeRenderStateResources,
  iterateRows,
  updateRenderState,
} from './render-state';

const PROBE_COLS = 8;
const PROBE_ROWS = 2;
const CACHE_LIMIT = 512;

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

// 终端自己的宽度规则：WASM 没有导出宽度查询，唯一权威是内核写入 grapheme 后给 cell 标的 widthKind
// （与渲染 / 选区 / 链接读到的是同一份）。这里用一个独占的探测终端把 grapheme 写进去读首格，
// 结果按 grapheme 缓存；可打印 ASCII 恒为 1 列，不进探测。探测终端按需创建、随控制器释放。
export class GraphemeWidthProbe {
  private terminal = 0;
  private renderState: GhosttyRenderStateResources | null = null;
  private readonly cache = new Map<string, 1 | 2>();
  private disposed = false;

  constructor(private readonly bindings: GhosttyBindings) {}

  width(text: string): 1 | 2 {
    if (text.length === 1) {
      const code = text.charCodeAt(0);
      if (code >= 0x20 && code <= 0x7e) {
        return 1;
      }
    }
    if (this.disposed || text === '' || hasControlCharacter(text)) {
      return 1;
    }

    const cached = this.cache.get(text);
    if (cached !== undefined) {
      return cached;
    }

    const width = this.measure(text);
    if (this.cache.size >= CACHE_LIMIT) {
      this.cache.clear();
    }
    this.cache.set(text, width);
    return width;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.cache.clear();
    if (this.renderState) {
      disposeRenderStateResources(this.renderState);
      this.renderState = null;
    }
    if (this.terminal !== 0) {
      this.bindings.freeTerminal(this.terminal);
      this.terminal = 0;
    }
  }

  private measure(text: string): 1 | 2 {
    const state = this.ensureProbe();
    this.bindings.resetTerminal(this.terminal);
    this.bindings.writeVt(this.terminal, text);
    updateRenderState(state, this.terminal);
    const rows = Array.from(iterateRows(state));
    return rows[0]?.cells[0]?.widthKind === 'wide' ? 2 : 1;
  }

  private ensureProbe(): GhosttyRenderStateResources {
    if (this.renderState) {
      return this.renderState;
    }

    this.terminal = this.bindings.createTerminal(PROBE_COLS, PROBE_ROWS, 0);
    try {
      this.renderState = createRenderState(this.bindings);
    } catch (error) {
      this.bindings.freeTerminal(this.terminal);
      this.terminal = 0;
      throw error;
    }
    return this.renderState;
  }
}
