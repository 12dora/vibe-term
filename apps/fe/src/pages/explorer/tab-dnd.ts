// 标签页拖拽的纯逻辑：插入位置换算、拖拽类型判定，以及拖拽中的标签页 id 镜像。
// 刻意不依赖面板包，纯函数可以单独测试。

export const EXPLORER_TAB_MIME = 'application/x-vibeterm-explorer-tab';

/** 文件拖到标签页上悬停多久后切到该标签页 */
export const TAB_SPRING_LOAD_MS = 600;

// dragover 阶段 getData 不可读，拖拽中的标签页 id 在模块内留一份镜像（dragstart 写入、dragend 清空）。
let draggedTabId: string | null = null;

export function setDraggedTabId(tabId: string | null): void {
  draggedTabId = tabId;
}

export function getDraggedTabId(): string | null {
  return draggedTabId;
}

// Firefox 的 dataTransfer.types 是 DOMStringList（无 includes），故 Array.from。
function dragTypes(dt: Pick<DataTransfer, 'types'>): string[] {
  return Array.from(dt.types as ArrayLike<string>);
}

export function hasTabDrag(dt: Pick<DataTransfer, 'types'>): boolean {
  return dragTypes(dt).includes(EXPLORER_TAB_MIME);
}

/** 从系统拖进来的文件 */
export function hasOsFileDrag(dt: Pick<DataTransfer, 'types'>): boolean {
  return dragTypes(dt).includes('Files');
}

/** 指针 X 落在第几个标签页的中线之前，就插到第几位；都不是则插到末尾 */
export function insertionIndex(midpoints: readonly number[], x: number): number {
  const index = midpoints.findIndex((mid) => x < mid);
  return index < 0 ? midpoints.length : index;
}

/**
 * 同一分栏内重排：把「拖拽时看到的插入位」换算成 store 要的「移除后的下标」。
 * 插到自己前面或紧跟自己后面都等于原地不动。
 */
export function adjustIndexForSamePane(fromIndex: number, insertion: number): number {
  if (fromIndex < 0) return insertion;
  return insertion > fromIndex ? insertion - 1 : insertion;
}

/** 文件拖到标签页上的放置效果：同节点且没按复制修饰键是移动，否则复制 */
export function tabFileDropEffect(
  sourceNodeId: string | null | undefined,
  tabNodeId: string,
  copyModifier: boolean
): 'move' | 'copy' {
  return sourceNodeId === tabNodeId && !copyModifier ? 'move' : 'copy';
}

export interface TabStripMetrics {
  /** 各标签页中线的视口 X（与 clientX 同坐标系） */
  midpoints: number[];
  /** 各插入位在标签行内的 X 偏移（长度 = 标签数 + 1） */
  edges: number[];
}

/** 量出标签行里每个标签页的位置（只认带 data-tab-id 的直接子元素） */
export function measureTabStrip(row: HTMLElement): TabStripMetrics {
  const midpoints: number[] = [];
  const edges: number[] = [];
  let end = 0;
  for (const child of Array.from(row.children)) {
    if (!(child instanceof HTMLElement) || !child.dataset.tabId) continue;
    const rect = child.getBoundingClientRect();
    midpoints.push(rect.left + rect.width / 2);
    edges.push(child.offsetLeft);
    end = child.offsetLeft + child.offsetWidth;
  }
  edges.push(end);
  return { midpoints, edges };
}
