export type KeywordRule<T> = readonly [keywords: readonly string[], category: T];

/**
 * 关键词表分类：按 `rules` 顺序取第一条命中的类别，顺序即优先级。
 * `reason` 会先转小写，未命中时交给 `fallback`。
 */
export function classifyByKeywords<T>(
  reason: string,
  rules: ReadonlyArray<KeywordRule<T>>,
  fallback: (normalized: string) => T
): T {
  const normalized = reason.toLowerCase();
  for (const [keywords, category] of rules) {
    if (keywords.some((keyword) => normalized.includes(keyword))) return category;
  }
  return fallback(normalized);
}

export function truncateReason(reason: string, max = 64): string {
  return reason.length > max ? reason.slice(0, max) : reason;
}
