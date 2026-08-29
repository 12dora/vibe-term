import {
  GHOSTTY_SCROLL_VIEWPORT_BOTTOM,
  GHOSTTY_SCROLL_VIEWPORT_DELTA,
  GHOSTTY_SCROLL_VIEWPORT_TOP,
  GHOSTTY_TERMINAL_DATA_COLS,
  GHOSTTY_TERMINAL_DATA_ROWS,
  GHOSTTY_TERMINAL_DATA_SCROLLBAR,
  GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND,
  GHOSTTY_TERMINAL_OPT_COLOR_CURSOR,
  GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND,
  GHOSTTY_TERMINAL_OPT_COLOR_PALETTE,
  assertResult,
} from './ghostty-wasm-abi';
import { GhosttyBindingsCore, type StructAllocation } from './ghostty-wasm-core';
import type { GhosttyCellDimensions, GhosttyTheme } from './types';

function parseHexRgb(hex: string): [number, number, number] {
  const normalized = hex.trim().replace(/^#/, '');
  if (normalized.length !== 6) {
    throw new Error(`expected #RRGGBB color, received: ${hex}`);
  }

  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function createAnsi256Palette(theme: GhosttyTheme): Array<[number, number, number]> {
  const base16 = [
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite,
  ].map(parseHexRgb);

  const palette = [...base16];
  const cube = [0, 95, 135, 175, 215, 255];

  for (const red of cube) {
    for (const green of cube) {
      for (const blue of cube) {
        palette.push([red, green, blue]);
      }
    }
  }

  for (let index = 0; index < 24; index += 1) {
    const value = 8 + index * 10;
    palette.push([value, value, value]);
  }

  return palette;
}

export class GhosttyBindingsTerminal extends GhosttyBindingsCore {
  createTerminal(cols: number, rows: number, scrollback: number): number {
    const options = this.allocStruct('GhosttyTerminalOptions');
    this.setField(options.view, 'GhosttyTerminalOptions', 'cols', cols);
    this.setField(options.view, 'GhosttyTerminalOptions', 'rows', rows);
    this.setField(options.view, 'GhosttyTerminalOptions', 'max_scrollback', scrollback);

    const termPtrPtr = this.allocOpaque();

    try {
      assertResult(
        this.exports.ghostty_terminal_new(0, termPtrPtr, options.ptr),
        'ghostty_terminal_new'
      );
      return this.readPointer(termPtrPtr);
    } finally {
      options.free();
      this.freeOpaque(termPtrPtr);
    }
  }

  freeTerminal(terminal: number): void {
    this.exports.ghostty_terminal_free(terminal);
  }

  writeVt(terminal: number, data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? this.encoder.encode(data) : data;
    const allocation = this.writeBytes(bytes);

    try {
      this.exports.ghostty_terminal_vt_write(terminal, allocation.ptr, allocation.len);
    } finally {
      allocation.free();
    }
  }

  resetTerminal(terminal: number): void {
    this.exports.ghostty_terminal_reset(terminal);
  }

  resizeTerminal(terminal: number, cols: number, rows: number, cell: GhosttyCellDimensions): void {
    assertResult(
      this.exports.ghostty_terminal_resize(
        terminal,
        cols,
        rows,
        Math.max(1, Math.round(cell.width)),
        Math.max(1, Math.round(cell.height))
      ),
      'ghostty_terminal_resize'
    );
  }

  scrollViewportDelta(terminal: number, delta: number): void {
    const behavior = this.allocStruct('GhosttyTerminalScrollViewport');

    try {
      this.setField(
        behavior.view,
        'GhosttyTerminalScrollViewport',
        'tag',
        GHOSTTY_SCROLL_VIEWPORT_DELTA
      );
      behavior.view.setBigInt64(
        this.field('GhosttyTerminalScrollViewport', 'value').offset,
        BigInt(delta),
        true
      );
      this.exports.ghostty_terminal_scroll_viewport(terminal, behavior.ptr);
    } finally {
      behavior.free();
    }
  }

  scrollViewportTop(terminal: number): void {
    const behavior = this.allocStruct('GhosttyTerminalScrollViewport');

    try {
      this.setField(
        behavior.view,
        'GhosttyTerminalScrollViewport',
        'tag',
        GHOSTTY_SCROLL_VIEWPORT_TOP
      );
      this.exports.ghostty_terminal_scroll_viewport(terminal, behavior.ptr);
    } finally {
      behavior.free();
    }
  }

  scrollViewportBottom(terminal: number): void {
    const behavior = this.allocStruct('GhosttyTerminalScrollViewport');

    try {
      this.setField(
        behavior.view,
        'GhosttyTerminalScrollViewport',
        'tag',
        GHOSTTY_SCROLL_VIEWPORT_BOTTOM
      );
      this.exports.ghostty_terminal_scroll_viewport(terminal, behavior.ptr);
    } finally {
      behavior.free();
    }
  }

  setTerminalTheme(terminal: number, theme: GhosttyTheme): void {
    let foreground: StructAllocation | null = null;
    let background: StructAllocation | null = null;
    let cursor: StructAllocation | null = null;
    let palettePtr: number | null = null;
    let paletteLen = 0;

    try {
      foreground = this.allocStruct('GhosttyColorRgb');
      background = this.allocStruct('GhosttyColorRgb');
      cursor = this.allocStruct('GhosttyColorRgb');

      // parseHexRgb 会对非法颜色串抛错，故解析与写入必须与释放同处一个 try/finally。
      const paletteColors = createAnsi256Palette(theme);
      paletteLen = paletteColors.length * 3;
      palettePtr = this.allocBytes(paletteLen);

      const assignRgb = (target: StructAllocation, value: string) => {
        const [red, green, blue] = parseHexRgb(value);
        this.setField(target.view, 'GhosttyColorRgb', 'r', red);
        this.setField(target.view, 'GhosttyColorRgb', 'g', green);
        this.setField(target.view, 'GhosttyColorRgb', 'b', blue);
      };

      assignRgb(foreground, theme.foreground);
      assignRgb(background, theme.background);
      assignRgb(cursor, theme.cursor);

      const paletteBytes = this.bytes(palettePtr, paletteLen);
      paletteColors.forEach(([red, green, blue], index) => {
        const offset = index * 3;
        paletteBytes[offset] = red;
        paletteBytes[offset + 1] = green;
        paletteBytes[offset + 2] = blue;
      });

      assertResult(
        this.exports.ghostty_terminal_set(
          terminal,
          GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND,
          foreground.ptr
        ),
        'ghostty_terminal_set(foreground)'
      );
      assertResult(
        this.exports.ghostty_terminal_set(
          terminal,
          GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND,
          background.ptr
        ),
        'ghostty_terminal_set(background)'
      );
      assertResult(
        this.exports.ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, cursor.ptr),
        'ghostty_terminal_set(cursor)'
      );
      assertResult(
        this.exports.ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, palettePtr),
        'ghostty_terminal_set(palette)'
      );
    } finally {
      foreground?.free();
      background?.free();
      cursor?.free();
      if (palettePtr !== null) {
        this.freeBytes(palettePtr, paletteLen);
      }
    }
  }

  readTerminalSize(terminal: number): { cols: number; rows: number } {
    const colsPtr = this.allocBytes(2);
    const rowsPtr = this.allocBytes(2);

    try {
      assertResult(
        this.exports.ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_COLS, colsPtr),
        'ghostty_terminal_get(cols)'
      );
      assertResult(
        this.exports.ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_ROWS, rowsPtr),
        'ghostty_terminal_get(rows)'
      );
      return {
        cols: this.view().getUint16(colsPtr, true),
        rows: this.view().getUint16(rowsPtr, true),
      };
    } finally {
      this.freeBytes(colsPtr, 2);
      this.freeBytes(rowsPtr, 2);
    }
  }

  readScrollbar(terminal: number): { total: number; offset: number; len: number } {
    const scrollbar = this.allocStruct('GhosttyTerminalScrollbar');

    try {
      assertResult(
        this.exports.ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_SCROLLBAR, scrollbar.ptr),
        'ghostty_terminal_get(scrollbar)'
      );

      return {
        total: Number(
          scrollbar.view.getBigUint64(this.field('GhosttyTerminalScrollbar', 'total').offset, true)
        ),
        offset: Number(
          scrollbar.view.getBigUint64(this.field('GhosttyTerminalScrollbar', 'offset').offset, true)
        ),
        len: Number(
          scrollbar.view.getBigUint64(this.field('GhosttyTerminalScrollbar', 'len').offset, true)
        ),
      };
    } finally {
      scrollbar.free();
    }
  }

  isTerminalModeEnabled(terminal: number, mode: number): boolean {
    const valuePtr = this.allocU8();

    try {
      assertResult(
        this.exports.ghostty_terminal_mode_get(terminal, mode, valuePtr),
        'ghostty_terminal_mode_get'
      );
      return this.readU8(valuePtr) !== 0;
    } finally {
      this.freeU8(valuePtr);
    }
  }

  setTerminalMode(terminal: number, mode: number, enabled: boolean): void {
    assertResult(
      this.exports.ghostty_terminal_mode_set(terminal, mode, enabled ? 1 : 0),
      'ghostty_terminal_mode_set'
    );
  }
}
