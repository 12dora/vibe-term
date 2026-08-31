// 指引里的分段选择器：一级（移动设备 / 服务器或电脑）铺满，二级（平台、接入方式）按内容宽度。
// 视觉与侧栏的三个标签一致（灰轨道 + 药丸）。
//
// 这里只出按钮行：内容必须由调用方用 <TabsContent> 放进**同一个** <Tabs> 根下，
// 关联 id（aria-controls / role=tabpanel / aria-labelledby）才立得起来。
// 两者在 DOM 上不必相邻——「选择接入方式」那步就是按钮在卡片里、分支步骤在卡片外。

import { TabsList, TabsTrigger, pillTabTriggerClassName } from '@tmex/ui/tabs';

export interface GuideTabOption<T extends string> {
  value: T;
  label: string;
  testId: string;
}

export function GuideTabList<T extends string>({
  options,
  fullWidth = false,
}: {
  options: GuideTabOption<T>[];
  fullWidth?: boolean;
}) {
  return (
    <TabsList
      className={`rounded-xl border border-border/60 p-1 ${fullWidth ? 'w-full' : 'w-fit'}`}
    >
      {options.map((option) => (
        <TabsTrigger
          key={option.value}
          value={option.value}
          data-testid={option.testId}
          className={pillTabTriggerClassName}
        >
          {option.label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
