import { GhosttyTerminalController } from './terminal';
import type { CompatibleTerminalLike, GhosttyTerminalSize } from './types';

// xterm 的 FitAddon 兼容实现：按容器实测尺寸算出 cols/rows 并 resize 终端。
export class FitAddon {
  private terminal: GhosttyTerminalController | null = null;

  activate(terminal: CompatibleTerminalLike): void {
    this.terminal = terminal instanceof GhosttyTerminalController ? terminal : null;
  }

  fit(): void {
    const proposed = this.proposeDimensions();
    if (!this.terminal || !proposed) {
      return;
    }

    this.terminal.resize(proposed.cols, proposed.rows);
  }

  proposeDimensions(): GhosttyTerminalSize | null {
    return this.terminal?.measureSizeFromElement() ?? null;
  }

  dispose(): void {
    this.terminal = null;
  }
}
