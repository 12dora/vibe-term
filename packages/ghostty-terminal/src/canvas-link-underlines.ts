export type LinkUnderlineSegment = {
  /** 视口内行号（0 起） */
  row: number;
  startCol: number;
  endCol: number;
};

export type LinkUnderlineGeometry = {
  dpr: number;
  deviceCellWidth: number;
  deviceCellHeight: number;
  textTopGap: number;
  glyphBoxHeight: number;
};

// 链接虚线下划线：调用方已清空本层，这里只负责按段落笔（段数少，每次全量重画）。
export function drawLinkUnderlineSegments(
  context: CanvasRenderingContext2D,
  segments: readonly LinkUnderlineSegment[],
  color: string,
  geometry: LinkUnderlineGeometry
): void {
  if (segments.length === 0) {
    return;
  }

  const { dpr, deviceCellWidth, deviceCellHeight, textTopGap, glyphBoxHeight } = geometry;
  const thickness = Math.max(1, Math.round(dpr));
  const dash = Math.max(2, Math.round(2 * dpr));
  // 奇数线宽时偏移 0.5 物理像素，避免 1px 线被抗锯齿糊成 2px。
  const crisp = thickness % 2 === 1 ? 0.5 : 0;

  context.strokeStyle = color;
  context.globalAlpha = 0.55;
  context.lineWidth = thickness;
  context.setLineDash([dash, dash]);
  context.beginPath();
  for (const segment of segments) {
    const cellTop = segment.row * deviceCellHeight;
    const y =
      Math.min(
        Math.round(cellTop + textTopGap + glyphBoxHeight - thickness),
        cellTop + deviceCellHeight - thickness
      ) + crisp;
    context.moveTo(segment.startCol * deviceCellWidth, y);
    context.lineTo((segment.endCol + 1) * deviceCellWidth, y);
  }
  context.stroke();
  context.setLineDash([]);
  context.globalAlpha = 1;
}
