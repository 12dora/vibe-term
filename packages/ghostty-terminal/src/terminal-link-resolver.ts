import { ExplicitLinkIndex } from './explicit-links';
import type { FileLinkContext } from './file-path';
import { GhosttyHyperlinkReader } from './ghostty-hyperlink';
import type { GhosttyBindings } from './ghostty-wasm';
import type { SelectionPoint } from './selection-model';
import {
  type LineModelReader,
  LinkMatchCache,
  type LinkQuery,
  type LinkUnderlineSegment,
  collectLinkUnderlineSegments,
  findLinkAtPoint,
} from './terminal-links';
import type { TerminalLinkHit } from './terminal-pointer-shared';
import type { GhosttyRenderRow } from './types';

const LINK_MATCH_CACHE_LIMIT = 300;

/**
 * 最近一帧渲染的视口快照。synced = 内核网格自那一帧以来没有未渲染的写入 / resize / reset：
 * 只有此时才允许为未缓存的行查内核 OSC 8 URI。
 */
export type LinkViewState = {
  rows: readonly GhosttyRenderRow[];
  offset: number;
  viewportRows: number;
  synced: boolean;
  getLineModel: LineModelReader;
  fileLinkContext: FileLinkContext | null;
};

// 链接命中与下划线的入口：正则检测（按逻辑行文本 LRU）+ OSC 8 explicit 段（按行 cells 缓存）。
export class TerminalLinkResolver {
  private readonly matches = new LinkMatchCache(LINK_MATCH_CACHE_LIMIT);
  private readonly explicit: ExplicitLinkIndex;

  constructor(bindings: GhosttyBindings, terminal: number) {
    this.explicit = new ExplicitLinkIndex(new GhosttyHyperlinkReader(bindings, terminal));
  }

  hitAt(point: SelectionPoint, view: LinkViewState): TerminalLinkHit | null {
    return findLinkAtPoint({ ...this.query(view), ...point });
  }

  segments(view: LinkViewState): LinkUnderlineSegment[] {
    return collectLinkUnderlineSegments({
      ...this.query(view),
      offset: view.offset,
      rows: view.viewportRows,
    });
  }

  // 在 renderNow 取完行、任何外部回调之前调用：此刻内核与 renderedRows 一致，为新出现的带链接行
  // 查好 URI 并缓存，之后命中与下划线不再依赖「查询时恰好同步」（持续输出时节流重算多半落在不同步窗口）。
  warm(view: LinkViewState): void {
    if (!view.synced) {
      return;
    }
    const source = this.explicit.source(view.rows, view.offset, true);
    for (let index = 0; index < view.rows.length; index += 1) {
      source(view.offset + index);
    }
  }

  clearMatches(): void {
    this.matches.clear();
  }

  dispose(): void {
    this.explicit.dispose();
  }

  private query(view: LinkViewState): LinkQuery {
    return {
      getLineModel: view.getLineModel,
      cache: this.matches,
      fileLinkContext: view.fileLinkContext,
      explicitLinks: this.explicit.source(view.rows, view.offset, view.synced),
    };
  }
}
