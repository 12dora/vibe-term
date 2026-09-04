// 指引里的分段选择器：一级（移动设备 / 服务器或电脑、三条接入路径）铺满或按内容宽度，
// 二级（平台、加入 / 自建）用 `line` 变体——只有下划线，比一级轻一档。
//
// 这里只出按钮行：内容必须由调用方用 <TabsContent> 放进**同一个** <Tabs> 根下，
// 关联 id（aria-controls / role=tabpanel / aria-labelledby）才立得起来。

import { TabsList, TabsTrigger, pillTabTriggerClassName } from '@tmex/ui/tabs';

export interface GuideTabOption<T extends string> {
  value: T;
  label: string;
  testId: string;
}

export function GuideTabList<T extends string>({
  options,
  fullWidth = false,
  variant = 'pill',
}: {
  options: GuideTabOption<T>[];
  fullWidth?: boolean;
  variant?: 'pill' | 'line';
}) {
  const line = variant === 'line';
  return (
    <TabsList
      variant={line ? 'line' : 'default'}
      className={
        line
          ? 'gap-3 p-0 text-xs'
          : `rounded-xl border border-border/60 p-1 ${fullWidth ? 'w-full' : 'w-fit'}`
      }
    >
      {options.map((option) => (
        <TabsTrigger
          key={option.value}
          value={option.value}
          data-testid={option.testId}
          className={line ? 'px-0 text-[13px] font-normal' : pillTabTriggerClassName}
        >
          {option.label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
