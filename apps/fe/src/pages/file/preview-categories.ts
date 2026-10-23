// 预览页的文件类别：唯一一份定义，查看器分发、兄弟选取、方向键与按钮形态都从这里取。

import type { FileCategory } from '@vibeterm/shared';

/** 整页铺开的媒体类：兄弟切换用边缘悬浮按钮 + 方向键。 */
export const MEDIA_CATEGORIES: ReadonlySet<FileCategory> = new Set<FileCategory>([
  'image',
  'pdf',
  'audio',
  'video',
]);

/** 文本类：悬浮按钮会盖住正文与滚动条，切换按钮放进页头；方向键留给选择 / 滚动。 */
export const TEXT_CATEGORIES: ReadonlySet<FileCategory> = new Set<FileCategory>([
  'code',
  'markdown',
  'text',
]);

export const PREVIEWABLE_CATEGORIES: ReadonlySet<FileCategory> = new Set<FileCategory>([
  ...MEDIA_CATEGORIES,
  ...TEXT_CATEGORIES,
]);
