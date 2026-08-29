import { assertResult } from './ghostty-wasm-abi';
import { GhosttyBindingsFormatter } from './ghostty-wasm-formatter';

export class GhosttyBindingsRenderState extends GhosttyBindingsFormatter {
  createRenderState(): number {
    const outStatePtr = this.allocOpaque();

    try {
      assertResult(
        this.exports.ghostty_render_state_new(0, outStatePtr),
        'ghostty_render_state_new'
      );
      return this.readPointer(outStatePtr);
    } finally {
      this.freeOpaque(outStatePtr);
    }
  }

  freeRenderState(state: number): void {
    this.exports.ghostty_render_state_free(state);
  }

  updateRenderState(state: number, terminal: number): void {
    assertResult(
      this.exports.ghostty_render_state_update(state, terminal),
      'ghostty_render_state_update'
    );
  }

  getRenderStateValueResult(state: number, data: number, outPtr: number): number {
    return this.exports.ghostty_render_state_get(state, data, outPtr);
  }

  getRenderStateValue(state: number, data: number, outPtr: number): void {
    assertResult(this.getRenderStateValueResult(state, data, outPtr), 'ghostty_render_state_get');
  }

  setRenderStateValue(state: number, option: number, valuePtr: number): void {
    assertResult(
      this.exports.ghostty_render_state_set(state, option, valuePtr),
      'ghostty_render_state_set'
    );
  }

  getRenderStateColors(state: number, outColorsPtr: number): void {
    assertResult(
      this.exports.ghostty_render_state_colors_get(state, outColorsPtr),
      'ghostty_render_state_colors_get'
    );
  }

  createRenderStateRowIterator(): number {
    const outIteratorPtr = this.allocOpaque();

    try {
      assertResult(
        this.exports.ghostty_render_state_row_iterator_new(0, outIteratorPtr),
        'ghostty_render_state_row_iterator_new'
      );
      return this.readPointer(outIteratorPtr);
    } finally {
      this.freeOpaque(outIteratorPtr);
    }
  }

  freeRenderStateRowIterator(iterator: number): void {
    this.exports.ghostty_render_state_row_iterator_free(iterator);
  }

  bindRenderStateRowIterator(state: number, iterator: number): void {
    const outPtr = this.allocOpaque();

    try {
      this.view(outPtr, 4).setUint32(0, iterator, true);
      this.getRenderStateValue(state, 4, outPtr);
    } finally {
      this.freeOpaque(outPtr);
    }
  }

  nextRenderStateRowIterator(iterator: number): boolean {
    return this.exports.ghostty_render_state_row_iterator_next(iterator) !== 0;
  }

  getRenderStateRowValueResult(iterator: number, data: number, outPtr: number): number {
    return this.exports.ghostty_render_state_row_get(iterator, data, outPtr);
  }

  getRenderStateRowValue(iterator: number, data: number, outPtr: number): void {
    assertResult(
      this.getRenderStateRowValueResult(iterator, data, outPtr),
      'ghostty_render_state_row_get'
    );
  }

  setRenderStateRowValue(iterator: number, option: number, valuePtr: number): void {
    assertResult(
      this.exports.ghostty_render_state_row_set(iterator, option, valuePtr),
      'ghostty_render_state_row_set'
    );
  }

  createRenderStateRowCells(): number {
    const outCellsPtr = this.allocOpaque();

    try {
      assertResult(
        this.exports.ghostty_render_state_row_cells_new(0, outCellsPtr),
        'ghostty_render_state_row_cells_new'
      );
      return this.readPointer(outCellsPtr);
    } finally {
      this.freeOpaque(outCellsPtr);
    }
  }

  freeRenderStateRowCells(cells: number): void {
    this.exports.ghostty_render_state_row_cells_free(cells);
  }

  bindRenderStateRowCells(iterator: number, cells: number): void {
    const outPtr = this.allocOpaque();

    try {
      this.view(outPtr, 4).setUint32(0, cells, true);
      this.getRenderStateRowValue(iterator, 3, outPtr);
    } finally {
      this.freeOpaque(outPtr);
    }
  }

  nextRenderStateRowCell(cells: number): boolean {
    return this.exports.ghostty_render_state_row_cells_next(cells) !== 0;
  }

  selectRenderStateRowCell(cells: number, x: number): void {
    assertResult(
      this.exports.ghostty_render_state_row_cells_select(cells, x),
      'ghostty_render_state_row_cells_select'
    );
  }

  getRenderStateRowCellValueResult(cells: number, data: number, outPtr: number): number {
    return this.exports.ghostty_render_state_row_cells_get(cells, data, outPtr);
  }

  getRenderStateRowCellValue(cells: number, data: number, outPtr: number): void {
    assertResult(
      this.getRenderStateRowCellValueResult(cells, data, outPtr),
      'ghostty_render_state_row_cells_get'
    );
  }

  getRawRowValueResult(row: bigint, data: number, outPtr: number): number {
    return this.exports.ghostty_row_get(row, data, outPtr);
  }

  getRawRowValue(row: bigint, data: number, outPtr: number): void {
    assertResult(this.getRawRowValueResult(row, data, outPtr), 'ghostty_row_get');
  }

  getRawCellValueResult(cell: bigint, data: number, outPtr: number): number {
    return this.exports.ghostty_cell_get(cell, data, outPtr);
  }

  getRawCellValue(cell: bigint, data: number, outPtr: number): void {
    assertResult(this.getRawCellValueResult(cell, data, outPtr), 'ghostty_cell_get');
  }
}
