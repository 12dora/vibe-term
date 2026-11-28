import type { GhosttyBindings } from './ghostty-wasm';

const GHOSTTY_SUCCESS = 0;
const GHOSTTY_OUT_OF_SPACE = -3;
const GHOSTTY_POINT_TAG_VIEWPORT = 1;

const INITIAL_URI_BUFFER_BYTES = 256;
// 链接策略按 4096 个 UTF-16 单元截断；UTF-8 每单元最多 3 字节，超过即不可能合规，不再扩容读取。
export const MAX_HYPERLINK_URI_BYTES = 4096 * 3;
/** URI 存在但超长被拒：与「读不到」(null) 区分，调用方可以缓存这一结论。 */
export const REJECTED_HYPERLINK_URI = '';

type HyperlinkScratch = {
  point: number;
  pointSize: number;
  coord: number;
  coordSize: number;
  ref: number;
  refSize: number;
  outLen: number;
};

// 按视口坐标读 OSC 8 URI（ghostty_terminal_grid_ref → ghostty_grid_ref_hyperlink_uri）。
// grid_ref 不是渲染热路径 API：只在命中测试 / 节流后的下划线重算里、且只对带 hyperlink
// 标记的格子调用。结构体与输出缓冲常驻复用，dispose 时统一归还。
export class GhosttyHyperlinkReader {
  private scratch: HyperlinkScratch | null = null;
  private buffer = 0;
  private bufferBytes = 0;
  private disposed = false;

  constructor(
    private readonly bindings: GhosttyBindings,
    private readonly terminal: number
  ) {}

  /** 当前 ghostty 视口：顶部绝对行号（与渲染协调器的 viewportOffset 同一坐标系）与行数。 */
  viewport(): { offset: number; rows: number } {
    if (this.disposed) {
      return { offset: 0, rows: 0 };
    }
    const scrollbar = this.bindings.readScrollbar(this.terminal);
    return { offset: scrollbar.offset, rows: scrollbar.len };
  }

  /** 无链接、坐标越界或已 dispose 时返回 null；超长返回 REJECTED_HYPERLINK_URI。 */
  uriAt(x: number, y: number): string | null {
    if (this.disposed) {
      return null;
    }
    const scratch = this.ensureScratch();
    if (!this.resolveGridRef(scratch, x, y)) {
      return null;
    }

    const wasm = this.bindings.exports;
    let status = wasm.ghostty_grid_ref_hyperlink_uri(
      scratch.ref,
      this.buffer,
      this.bufferBytes,
      scratch.outLen
    );
    if (status === GHOSTTY_OUT_OF_SPACE) {
      const required = this.bindings.readUsize(scratch.outLen);
      if (required > MAX_HYPERLINK_URI_BYTES) {
        return REJECTED_HYPERLINK_URI;
      }
      this.growBuffer(required);
      status = wasm.ghostty_grid_ref_hyperlink_uri(
        scratch.ref,
        this.buffer,
        this.bufferBytes,
        scratch.outLen
      );
    }
    if (status !== GHOSTTY_SUCCESS) {
      return null;
    }

    const length = this.bindings.readUsize(scratch.outLen);
    return length === 0 ? null : this.bindings.readOwnedUtf8(this.buffer, length);
  }

  dispose(): void {
    this.disposed = true;
    const scratch = this.scratch;
    if (scratch) {
      this.bindings.freeBytes(scratch.point, scratch.pointSize);
      this.bindings.freeBytes(scratch.ref, scratch.refSize);
      this.bindings.freeUsize(scratch.outLen);
      this.scratch = null;
    }
    this.releaseBuffer();
  }

  private resolveGridRef(scratch: HyperlinkScratch, x: number, y: number): boolean {
    const bindings = this.bindings;
    bindings.bytes(scratch.point, scratch.pointSize).fill(0);
    bindings.bytes(scratch.ref, scratch.refSize).fill(0);
    bindings.setField(
      bindings.view(scratch.point, scratch.pointSize),
      'GhosttyPoint',
      'tag',
      GHOSTTY_POINT_TAG_VIEWPORT
    );
    const coordView = bindings.view(scratch.coord, scratch.coordSize);
    bindings.setField(coordView, 'GhosttyPointCoordinate', 'x', x);
    bindings.setField(coordView, 'GhosttyPointCoordinate', 'y', y);
    bindings.setField(
      bindings.view(scratch.ref, scratch.refSize),
      'GhosttyGridRef',
      'size',
      scratch.refSize
    );
    const result = bindings.exports.ghostty_terminal_grid_ref(
      this.terminal,
      scratch.point,
      scratch.ref
    );
    return result === GHOSTTY_SUCCESS;
  }

  private ensureScratch(): HyperlinkScratch {
    if (this.scratch) {
      return this.scratch;
    }

    const bindings = this.bindings;
    const pointSize = bindings.typeSize('GhosttyPoint');
    const refSize = bindings.typeSize('GhosttyGridRef');
    const point = bindings.allocBytes(pointSize);
    const scratch: HyperlinkScratch = {
      point,
      pointSize,
      coord: point + bindings.field('GhosttyPoint', 'value').offset,
      coordSize: bindings.typeSize('GhosttyPointCoordinate'),
      ref: bindings.allocBytes(refSize),
      refSize,
      outLen: bindings.allocUsize(),
    };
    this.scratch = scratch;
    this.growBuffer(INITIAL_URI_BUFFER_BYTES);
    return scratch;
  }

  private growBuffer(required: number): void {
    if (required <= this.bufferBytes) {
      return;
    }
    this.releaseBuffer();
    this.buffer = this.bindings.allocBytes(required);
    this.bufferBytes = required;
  }

  private releaseBuffer(): void {
    if (this.bufferBytes > 0) {
      this.bindings.freeBytes(this.buffer, this.bufferBytes);
    }
    this.buffer = 0;
    this.bufferBytes = 0;
  }
}
