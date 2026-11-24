import { applyCanvasCssPixelSize } from './canvas-renderer-metrics';
import { ensureCanvasContext } from './canvas-scratch-pool';

export type LayerSurface = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
};

export type LayerSurfaceSize = {
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
};

export function gridLayerSize(
  cols: number,
  rows: number,
  deviceCellWidth: number,
  deviceCellHeight: number,
  dpr: number
): LayerSurfaceSize {
  const width = cols * deviceCellWidth;
  const height = rows * deviceCellHeight;
  return { width, height, cssWidth: width / dpr, cssHeight: height / dpr };
}

export function createLayerSurface(
  screenElement: HTMLElement,
  layer: string,
  before: HTMLElement | null = null
): LayerSurface {
  const canvas = document.createElement('canvas');
  canvas.dataset.layer = layer;
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  if (before) {
    screenElement.insertBefore(canvas, before);
  } else {
    screenElement.appendChild(canvas);
  }
  return { canvas, context: ensureCanvasContext(canvas) };
}

// canvas.width/height 赋值会清空位图并重置上下文状态，所以尺寸与上下文基线状态必须一起刷新。
export function sizeLayerSurfaces(surfaces: readonly LayerSurface[], size: LayerSurfaceSize): void {
  for (const { canvas, context } of surfaces) {
    canvas.width = size.width;
    canvas.height = size.height;
    applyCanvasCssPixelSize(canvas.style, size.cssWidth, size.cssHeight);
    context.setTransform(1, 0, 0, 1, 0, 0);
    // alphabetic：按真实 baseline 定位，配合 textBaselineY 精确居中字形盒。
    context.textBaseline = 'alphabetic';
    context.imageSmoothingEnabled = false;
  }
}
