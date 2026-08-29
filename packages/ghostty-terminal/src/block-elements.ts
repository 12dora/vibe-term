// 只依赖实际用到的 2D context 成员，便于测试用轻量假 context 直接传入。
type BlockPaintContext = Pick<CanvasRenderingContext2D, 'fillRect' | 'globalAlpha'>;

type BlockGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// fill 用 cell 内局部坐标（x0/y0/x1/y1），sx/sy 把 n/8 分割点 round 到整数物理像素，
// 相邻块元素的拼接处既不留缝也不重叠。
type BlockPainterOps = {
  width: number;
  height: number;
  sx: (n: number) => number;
  sy: (n: number) => number;
  fill: (x0: number, y0: number, x1: number, y1: number) => void;
  withAlpha: (alpha: number, paint: () => void) => void;
};

type BlockPainter = (ops: BlockPainterOps, codepoint: number) => void;

type BlockPainterRange = {
  from: number;
  to: number;
  paint: BlockPainter;
};

// U+2596–U+259F quadrant 块的象限组合：UL=1、UR=2、LL=4、LR=8
const QUADRANT_FLAGS = new Map<number, number>([
  [0x2596, 0b0100],
  [0x2597, 0b1000],
  [0x2598, 0b0001],
  [0x2599, 0b1101],
  [0x259a, 0b1001],
  [0x259b, 0b0111],
  [0x259c, 0b1011],
  [0x259d, 0b0010],
  [0x259e, 0b0110],
  [0x259f, 0b1110],
]);

const shadePainter =
  (alpha: number): BlockPainter =>
  (ops) => {
    ops.withAlpha(alpha, () => {
      ops.fill(0, 0, ops.width, ops.height);
    });
  };

const paintQuadrants: BlockPainter = (ops, codepoint) => {
  const quadrants = QUADRANT_FLAGS.get(codepoint) ?? 0;
  const midX = ops.sx(4);
  const midY = ops.sy(4);
  if (quadrants & 0b0001) ops.fill(0, 0, midX, midY);
  if (quadrants & 0b0010) ops.fill(midX, 0, ops.width, midY);
  if (quadrants & 0b0100) ops.fill(0, midY, midX, ops.height);
  if (quadrants & 0b1000) ops.fill(midX, midY, ops.width, ops.height);
};

const BLOCK_PAINTER_RANGES: BlockPainterRange[] = [
  // ▀ 上半块
  { from: 0x2580, to: 0x2580, paint: (ops) => ops.fill(0, 0, ops.width, ops.sy(4)) },
  // ▁..█ 自下而上 n/8
  {
    from: 0x2581,
    to: 0x2588,
    paint: (ops, codepoint) => ops.fill(0, ops.sy(8 - (codepoint - 0x2580)), ops.width, ops.height),
  },
  // ▉..▏ 自左起 n/8
  {
    from: 0x2589,
    to: 0x258f,
    paint: (ops, codepoint) => ops.fill(0, 0, ops.sx(0x2590 - codepoint), ops.height),
  },
  // ▐ 右半块
  { from: 0x2590, to: 0x2590, paint: (ops) => ops.fill(ops.sx(4), 0, ops.width, ops.height) },
  // ░▒▓ 按前景色 alpha 混合
  { from: 0x2591, to: 0x2591, paint: shadePainter(0.25) },
  { from: 0x2592, to: 0x2592, paint: shadePainter(0.5) },
  { from: 0x2593, to: 0x2593, paint: shadePainter(0.75) },
  // ▔ 上 1/8
  { from: 0x2594, to: 0x2594, paint: (ops) => ops.fill(0, 0, ops.width, ops.sy(1)) },
  // ▕ 右 1/8
  { from: 0x2595, to: 0x2595, paint: (ops) => ops.fill(ops.sx(7), 0, ops.width, ops.height) },
  { from: 0x2596, to: 0x259f, paint: paintQuadrants },
];

const BLOCK_PAINTERS = ((): Map<number, BlockPainter> => {
  const painters = new Map<number, BlockPainter>();
  for (const range of BLOCK_PAINTER_RANGES) {
    for (let codepoint = range.from; codepoint <= range.to; codepoint += 1) {
      painters.set(codepoint, range.paint);
    }
  }
  return painters;
})();

function createBlockPainterOps(
  context: BlockPaintContext,
  geometry: BlockGeometry
): BlockPainterOps {
  const { x, y, width, height } = geometry;
  return {
    width,
    height,
    sx: (n) => Math.round((width * n) / 8),
    sy: (n) => Math.round((height * n) / 8),
    fill: (x0, y0, x1, y1) => {
      context.fillRect(x + x0, y + y0, x1 - x0, y1 - y0);
    },
    withAlpha: (alpha, paint) => {
      const previousAlpha = context.globalAlpha;
      context.globalAlpha = previousAlpha * alpha;
      paint();
      context.globalAlpha = previousAlpha;
    },
  };
}

export function isBlockElement(codepoint: number): boolean {
  return BLOCK_PAINTERS.has(codepoint);
}

// 块元素（▀▄█▌▐░▒▓ 等）不能交给字体：字形最多覆盖 1em，而 cell 高为 1.2em，
// 行列间会留缝（logo/色块图中的明显间隙），必须按 cell 精确自绘。
export function blockElementCodepoint(codepoints: number[]): number | null {
  const codepoint = codepoints.length === 1 ? codepoints[0] : undefined;
  return codepoint !== undefined && isBlockElement(codepoint) ? codepoint : null;
}

// fillStyle 由调用方设好。未登记的码位为 no-op。
export function drawBlockElement(
  context: BlockPaintContext,
  codepoint: number,
  geometry: BlockGeometry
): void {
  const paint = BLOCK_PAINTERS.get(codepoint);
  if (!paint) {
    return;
  }

  paint(createBlockPainterOps(context, geometry), codepoint);
}

export type { BlockGeometry, BlockPaintContext };
