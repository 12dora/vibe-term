// 乐观重排：按给定 id 顺序排出已知项，其余项保持原相对顺序追加在后。

export function reorderByIds<T extends { id: string }>(
  items: readonly T[],
  ids: readonly string[]
): T[] {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const known = ids.map((id) => byId.get(id)).filter((item) => item !== undefined);
  const rest = items.filter((item) => !ids.includes(item.id));
  return [...known, ...rest];
}
