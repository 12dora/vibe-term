export type GestureDeltaInput = {
  source: 'wheel' | 'touch';
  delta: number;
  deltaMode?: number;
  cellSize: number;
  pageSize: number;
};

function roundAwayFromZero(value: number): number {
  return value > 0 ? Math.ceil(value) : Math.floor(value);
}

function truncateTowardZero(value: number): number {
  return value > 0 ? Math.floor(value) : Math.ceil(value);
}

// 单轴的手势步进换算：非滚轮按 cell 尺寸向外取整，滚轮的 line/page 模式直接换算并丢弃像素余量，
// 像素模式则累积余量，只在够一个 cell 时吐出整数步进。纵横两轴各持一个实例。
export class GestureDeltaAccumulator {
  private pixelRemainder = 0;

  reset(): void {
    this.pixelRemainder = 0;
  }

  consume(input: GestureDeltaInput): number {
    if (input.delta === 0) {
      return 0;
    }

    if (input.source !== 'wheel') {
      return roundAwayFromZero(input.delta / input.cellSize);
    }

    if (input.deltaMode === 1) {
      this.pixelRemainder = 0;
      return roundAwayFromZero(input.delta);
    }

    if (input.deltaMode === 2) {
      this.pixelRemainder = 0;
      return roundAwayFromZero(input.delta * Math.max(1, input.pageSize));
    }

    this.pixelRemainder += input.delta;
    const steps = truncateTowardZero(this.pixelRemainder / input.cellSize);
    if (steps !== 0) {
      this.pixelRemainder -= steps * input.cellSize;
    }
    return steps;
  }
}
