export interface TerminalScroller {
  scrollLines: (amount: number) => void;
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
// - scroll：非上报模式的单指滚动（原有行为）
// - pending：上报模式单指落下，尚未发出任何字节（tap/拖拽/长按/双指待定）
// - drag：press 已发，motion 流式上报（TUI 拖拽）
// - wheel：双指滚动 → 鼠标滚轮上报（handleViewportGesture 的上报分支编码 64/65）
// - select：长按本地 word 选择（上报/非上报共用；上报模式下是移动端的"Shift 豁免"）
export type TouchGestureState =
  | 'idle'
  | 'bypass'
  | 'scroll'
  | 'pending'
  | 'drag'
  | 'wheel'
  | 'select';
