/** 平移视口（follower 模式）的可滚状态；overflow* = 0 表示该轴不超尺寸。 */
export interface TerminalPanMetrics {
  scrollLeft: number;
  scrollTop: number;
  overflowX: number;
  overflowY: number;
}

export interface TerminalScroller {
  scrollLines: (amount: number) => void;
  /** 未启用平移（非 follower）或终端未挂载时返回 null */
  panMetrics?: () => TerminalPanMetrics | null;
  /** 返回真正落地的位移，未消费的余量由调用方回退给 scrollback */
  panBy?: (deltaX: number, deltaY: number) => { deltaX: number; deltaY: number };
  handleViewportGesture?: (gesture: {
    source: 'touch';
    deltaY: number;
    clientX: number;
    clientY: number;
  }) => boolean;
  startTouchSelection?: (
    clientX: number,
    clientY: number,
    mode?: 'character' | 'word' | 'line'
  ) => boolean;
  updateTouchSelection?: (clientX: number, clientY: number) => void;
  endTouchSelection?: () => void;
  isMouseReporting?: () => boolean;
  sendTouchMouseEvent?: (event: {
    action: 'press' | 'motion' | 'release';
    clientX: number;
    clientY: number;
  }) => boolean;
  noteTouchHandled?: () => void;
  focus?: () => void;
  buffer?: {
    active?: {
      viewportY?: number;
    };
  };
  _core?: {
    _renderService?: {
      dimensions?: {
        css?: {
          cell?: {
            height?: number;
          };
        };
      };
    };
  };
}

export type ResolveTerminal = () => TerminalScroller | null;

// 手势状态机（每次首指落下判定一次，全部手指抬起/取消后回 idle）：
// - idle：无手势
// - bypass：命中滚动条元素/热区，交还原生
// - scroll：单指滚动（非上报：本地滚动/altScroll；上报：编码成滚轮 64/65）
// - pan：单指平移超尺寸内容表面（仅 follower + 非上报；纵向到边后余量回落 scroll 语义）
// - pending：上报模式单指落下，尚未发出任何字节（tap/滚动/长按/双指待定）；
//   越过位移阈值即转 scroll——触摸端不提供单指 TUI 拖拽
// - wheel：双指滚动 → 鼠标滚轮上报（handleViewportGesture 的上报分支编码 64/65）
// - select：长按本地 word 选择（上报/非上报共用；上报模式下是移动端的"Shift 豁免"）
export type TouchGestureState =
  | 'idle'
  | 'bypass'
  | 'scroll'
  | 'pan'
  | 'pending'
  | 'wheel'
  | 'select';
