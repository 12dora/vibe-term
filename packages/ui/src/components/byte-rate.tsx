// 速率 / 字节量的展示槽位。数值每秒都在刷新，位数一变列宽就跟着抖，
// 所以这里固定三件事：等宽数字、不换行、右对齐的最小宽度。
// 本包不依赖 `@vibeterm/shared`，格式化仍由调用方做（`formatRate` / `formatBytesFixed`）。

import type * as React from 'react';

import { cn } from '../utils';

export interface ByteRateProps extends React.ComponentProps<'span'> {
  /** 覆盖默认最小宽度。默认按 `000.0 KB/s` 取 7.5ch；整格摆两个读数时要给更宽的值。 */
  minWidthClass?: string;
}

export function ByteRate({ className, minWidthClass = 'min-w-[7.5ch]', ...props }: ByteRateProps) {
  return (
    <span
      data-slot="byte-rate"
      className={cn(
        'inline-block text-right whitespace-nowrap tabular-nums',
        minWidthClass,
        className
      )}
      {...props}
    />
  );
}
