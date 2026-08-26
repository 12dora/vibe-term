import { handleCsi } from './pane-stream/csi-handler';
import { handleEsc } from './pane-stream/esc-handler';
import { handleNormal } from './pane-stream/normal-handler';
import { handleOsc, handleScreenTitle } from './pane-stream/osc-handlers';
import { type ParserContext, createParserState } from './pane-stream/parser-state';
import { handleDcsDetect, handleTmuxPassthrough } from './pane-stream/tmux-passthrough-handler';

export type PaneStreamNotification = {
  source: 'osc9' | 'osc99' | 'osc777' | 'osc1337';
  title?: string;
  body: string;
};

// OSC 133 语义提示符标记（FinalTerm / shell 集成）：A 提示符开始 / B 命令开始 /
// C 输出开始 / D 命令结束（带退出码）。run_command 据此划分命令块。
export type PromptMarker = {
  kind: 'A' | 'B' | 'C' | 'D';
  exitCode: number | null;
  // kind 之后的分号分隔参数（如 D 的退出码、我们注入的 tmex=<nonce>）
  params: string[];
};

export interface PaneStreamParserOptions {
  onTitle: (title: string) => void;
  onCurrentPath?: (currentPath: string) => void;
  onBell: () => void;
  onNotification: (notification: PaneStreamNotification) => void;
  onPromptMarker?: (marker: PromptMarker) => void;
  onClipboardWrite?: (text: string) => void;
  // pane 内程序声明/撤销 DEC private mode 2031（主题变化通知订阅，CSI ?2031h / ?2031l）
  onThemeSubscription?: (subscribed: boolean) => void;
}

export interface PaneStreamParser {
  push(data: Uint8Array): Uint8Array;
}

function dispatchPaneStreamByte(ctx: ParserContext, byte: number): void {
  switch (ctx.state.phase) {
    case 'normal':
      handleNormal(ctx, byte);
      return;
    case 'esc':
      handleEsc(ctx, byte);
      return;
    case 'csi':
      handleCsi(ctx, byte);
      return;
    case 'osc-params':
    case 'osc-body':
    case 'osc-body-ignore':
    case 'osc-st':
    case 'osc-st-ignore':
      handleOsc(ctx, byte);
      return;
    case 'screen-title':
    case 'screen-title-st':
    case 'screen-title-ignore':
    case 'screen-title-st-ignore':
      handleScreenTitle(ctx, byte);
      return;
    case 'dcs-detect':
      handleDcsDetect(ctx, byte);
      return;
    case 'dcs-tmux':
    case 'dcs-tmux-esc':
    case 'dcs-tmux-ignore':
    case 'dcs-tmux-ignore-esc':
      handleTmuxPassthrough(ctx, byte);
      return;
  }
}

export function createPaneStreamParser(options: PaneStreamParserOptions): PaneStreamParser {
  const state = createParserState();
  return {
    push(data) {
      const ctx: ParserContext = {
        state,
        options,
        output: [],
        processByte(byte) {
          dispatchPaneStreamByte(this, byte);
        },
      };
      for (const byte of data) {
        ctx.processByte(byte);
      }
      return new Uint8Array(ctx.output);
    },
  };
}
