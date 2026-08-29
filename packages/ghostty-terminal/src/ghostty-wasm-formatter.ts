import { GHOSTTY_POINT_TAG_VIEWPORT, GHOSTTY_SUCCESS, assertResult } from './ghostty-wasm-abi';
import type { StructAllocation } from './ghostty-wasm-core';
import { GhosttyBindingsTerminal } from './ghostty-wasm-terminal';

export class GhosttyBindingsFormatter extends GhosttyBindingsTerminal {
  createFormatter(
    terminal: number,
    emit: number,
    options: {
      trim: boolean;
      unwrap: boolean;
      includePalette: boolean;
      selectionPtr?: number | null;
    }
  ): number {
    const formatterOptions = this.allocStruct('GhosttyFormatterTerminalOptions');
    const extraOffset = this.field('GhosttyFormatterTerminalOptions', 'extra').offset;
    const extraView = this.view(
      formatterOptions.ptr + extraOffset,
      this.typeSize('GhosttyFormatterTerminalExtra')
    );
    const screenOffset = this.field('GhosttyFormatterTerminalExtra', 'screen').offset;
    const screenView = this.view(
      formatterOptions.ptr + extraOffset + screenOffset,
      this.typeSize('GhosttyFormatterScreenExtra')
    );
    const outFormatterPtr = this.allocOpaque();

    try {
      this.setField(
        formatterOptions.view,
        'GhosttyFormatterTerminalOptions',
        'size',
        this.typeSize('GhosttyFormatterTerminalOptions')
      );
      this.setField(formatterOptions.view, 'GhosttyFormatterTerminalOptions', 'emit', emit);
      this.setField(
        formatterOptions.view,
        'GhosttyFormatterTerminalOptions',
        'unwrap',
        options.unwrap
      );
      this.setField(formatterOptions.view, 'GhosttyFormatterTerminalOptions', 'trim', options.trim);
      this.setField(
        extraView,
        'GhosttyFormatterTerminalExtra',
        'size',
        this.typeSize('GhosttyFormatterTerminalExtra')
      );
      this.setField(extraView, 'GhosttyFormatterTerminalExtra', 'palette', options.includePalette);
      this.setField(
        screenView,
        'GhosttyFormatterScreenExtra',
        'size',
        this.typeSize('GhosttyFormatterScreenExtra')
      );
      const selectionOffset = this.field('GhosttyFormatterTerminalOptions', 'selection').offset;
      formatterOptions.view.setUint32(selectionOffset, options.selectionPtr ?? 0, true);

      assertResult(
        this.exports.ghostty_formatter_terminal_new(
          0,
          outFormatterPtr,
          terminal,
          formatterOptions.ptr
        ),
        'ghostty_formatter_terminal_new'
      );

      return this.readPointer(outFormatterPtr);
    } finally {
      formatterOptions.free();
      this.freeOpaque(outFormatterPtr);
    }
  }

  freeFormatter(formatter: number): void {
    this.exports.ghostty_formatter_free(formatter);
  }

  private resolveViewportGridRef(terminal: number, x: number, y: number): StructAllocation | null {
    const point = this.allocStruct('GhosttyPoint');
    const outRef = this.allocStruct('GhosttyGridRef');

    try {
      this.setField(point.view, 'GhosttyPoint', 'tag', GHOSTTY_POINT_TAG_VIEWPORT);
      const coordOffset = this.field('GhosttyPoint', 'value').offset;
      const coordView = this.view(point.ptr + coordOffset, this.typeSize('GhosttyPointCoordinate'));
      this.setField(coordView, 'GhosttyPointCoordinate', 'x', x);
      this.setField(coordView, 'GhosttyPointCoordinate', 'y', y);

      const result = this.exports.ghostty_terminal_grid_ref(terminal, point.ptr, outRef.ptr);
      if (result !== GHOSTTY_SUCCESS) {
        outRef.free();
        return null;
      }

      return outRef;
    } finally {
      point.free();
    }
  }

  private createViewportSelection(
    terminal: number,
    cols: number,
    rows: number
  ): StructAllocation | null {
    const safeCols = Math.max(1, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));
    const start = this.resolveViewportGridRef(terminal, 0, 0);
    if (!start) {
      return null;
    }

    let end: StructAllocation | null = null;
    for (let row = safeRows - 1; row >= 0; row -= 1) {
      end = this.resolveViewportGridRef(terminal, safeCols - 1, row);
      if (end) {
        break;
      }
    }

    if (!end) {
      start.free();
      return null;
    }

    const selection = this.allocStruct('GhosttySelection');
    try {
      this.setField(selection.view, 'GhosttySelection', 'size', this.typeSize('GhosttySelection'));
      this.setField(selection.view, 'GhosttySelection', 'rectangle', false);

      const startOffset = this.field('GhosttySelection', 'start').offset;
      const endOffset = this.field('GhosttySelection', 'end').offset;
      this.bytes(selection.ptr + startOffset, this.typeSize('GhosttyGridRef')).set(
        this.bytes(start.ptr, this.typeSize('GhosttyGridRef'))
      );
      this.bytes(selection.ptr + endOffset, this.typeSize('GhosttyGridRef')).set(
        this.bytes(end.ptr, this.typeSize('GhosttyGridRef'))
      );

      return selection;
    } finally {
      start.free();
      end.free();
    }
  }

  formatViewport(
    terminal: number,
    emit: number,
    options: { trim: boolean; unwrap: boolean; includePalette: boolean },
    viewport: { cols: number; rows: number }
  ): string {
    const terminalSize = this.readTerminalSize(terminal);
    const selection = this.createViewportSelection(
      terminal,
      Math.max(1, Math.min(terminalSize.cols, viewport.cols)),
      Math.max(1, Math.min(terminalSize.rows, viewport.rows))
    );

    try {
      const formatter = this.createFormatter(terminal, emit, {
        ...options,
        selectionPtr: selection?.ptr ?? null,
      });

      try {
        return this.formatFormatter(formatter);
      } finally {
        this.freeFormatter(formatter);
      }
    } finally {
      selection?.free();
    }
  }

  formatFormatter(formatter: number): string {
    const outPtrPtr = this.allocOpaque();
    const outLenPtr = this.allocUsize();

    try {
      assertResult(
        this.exports.ghostty_formatter_format_alloc(formatter, 0, outPtrPtr, outLenPtr),
        'ghostty_formatter_format_alloc'
      );

      const outPtr = this.readPointer(outPtrPtr);
      const outLen = this.readUsize(outLenPtr);
      const memoryByteLength = this.buffer().byteLength;

      try {
        if (outLen === 0 || outPtr === 0) {
          return '';
        }

        if (outPtr < 0 || outPtr > memoryByteLength || outLen > memoryByteLength - outPtr) {
          throw new Error(
            `ghostty_formatter_format_alloc returned invalid slice ptr=${outPtr} len=${outLen} mem=${memoryByteLength}`
          );
        }

        return this.readOwnedUtf8(outPtr, outLen);
      } finally {
        if (outLen > 0 && outPtr !== 0) {
          this.exports.ghostty_free(0, outPtr, outLen);
        }
      }
    } finally {
      this.freeOpaque(outPtrPtr);
      this.freeUsize(outLenPtr);
    }
  }
}
