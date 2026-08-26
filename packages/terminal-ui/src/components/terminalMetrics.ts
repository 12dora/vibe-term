const FALLBACK_CELL_WIDTH = 9;
const FALLBACK_CELL_HEIGHT = 17;

export interface TerminalCellSize {
  width?: number;
  height?: number;
}

export interface ContainerSizeInput {
  rect: { width: number; height: number };
  cell: TerminalCellSize | null | undefined;
  /** fitAddon.proposeDimensions 的透传；缺席或抛错时按 cell 尺寸回退计算列数 */
  proposeDimensions?: (() => { cols: number } | null | undefined) | null;
}

export function computeContainerSize({
  rect,
  cell,
  proposeDimensions,
}: ContainerSizeInput): { cols: number; rows: number } | null {
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }

  let cols: number | null = null;
  if (proposeDimensions) {
    try {
      const proposed = proposeDimensions();
      if (proposed) {
        cols = Math.max(2, proposed.cols);
      }
    } catch {
      cols = null;
    }
  }
  if (cols === null) {
    cols = Math.max(2, Math.floor(rect.width / (cell?.width ?? FALLBACK_CELL_WIDTH)));
  }

  const rows = Math.max(2, Math.floor(rect.height / (cell?.height ?? FALLBACK_CELL_HEIGHT)));
  return { cols, rows };
}
