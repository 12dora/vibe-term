import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { Check, Minus } from 'lucide-react';

import { cn } from '../utils';

/**
 * 独立复选框（不依赖 Field）。Base UI 的 Root 渲染成带 `role="checkbox"` 的 span
 * 加一个隐藏 input，勾选态只走 `data-checked` / `data-indeterminate`。
 */
function Checkbox({ className, indeterminate, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      indeterminate={indeterminate}
      className={cn(
        'data-checked:bg-primary data-checked:text-primary-foreground data-checked:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground data-indeterminate:border-primary border-input dark:bg-input/30 dark:data-checked:bg-primary dark:data-indeterminate:bg-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border focus-visible:ring-3 aria-invalid:ring-3 peer relative inline-flex items-center justify-center transition-[background-color,border-color,box-shadow] duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none outline-none after:absolute after:-inset-2 data-disabled:cursor-not-allowed data-disabled:opacity-50',
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        {indeterminate ? <Minus className="size-3" /> : <Check className="size-3" />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
