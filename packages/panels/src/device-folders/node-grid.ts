// 节点磁贴网格的列模型（类名与跨度规则只在这里定义一次）。
//
// 列数由**节点列表容器自身的宽度**决定（容器查询，不是视口断点）：不足 48rem 一列，
// 48rem 起两列，80rem 起三列。根层与每个分组各是一个独立的容器，分组里窄一些就少一列。
// 节点磁贴的跨度 = min(设备数, 列数)：`data-span` 记的是「想占几列」，实际占几列由容器
// 查询类在当前列数下截断。条目永远按数据顺序流式排布，不做 dense 回填。

export type NodeTileSpan = 1 | 2 | 3;

/** `full`：独占整行（standalone 下唯一的那个节点，卡片网格与旧版式一致） */
export type NodeTileSize = NodeTileSpan | 'full';

export const NODE_GRID_MAX_COLUMNS = 3;

/** 容器查询的宿主：必须套在网格外面一层（容器查询只作用于后代，不作用于容器自己） */
export const NODE_GRID_CONTAINER_CLASS = '@container min-w-0';

export const NODE_GRID_CLASS =
  'grid min-w-0 grid-cols-1 gap-3 @[48rem]:grid-cols-2 @[80rem]:grid-cols-3';

/** 单列时一律 `col-span-1`：写成 `col-span-2` 会凭空撑出第二条隐式轨道 */
export const NODE_TILE_SPAN_CLASS: Record<NodeTileSize, string> = {
  1: 'col-span-1',
  2: 'col-span-1 @[48rem]:col-span-2',
  3: 'col-span-1 @[48rem]:col-span-2 @[80rem]:col-span-3',
  full: 'col-span-full',
};

/** 设备数 → 磁贴想占的列数；没有设备 / 数不出来的按一列算 */
export function nodeTileSpan(deviceCount: number): NodeTileSpan {
  if (!Number.isFinite(deviceCount) || deviceCount < 2) return 1;
  return deviceCount >= NODE_GRID_MAX_COLUMNS ? NODE_GRID_MAX_COLUMNS : 2;
}
