// 指引里的分段选择器：一级（移动设备 / 服务器或电脑）铺满，二级（平台、接入方式）按内容宽度。
// 视觉与侧栏的三个标签一致（灰轨道 + 药丸）。

import { Tabs, TabsList, TabsTrigger, pillTabTriggerClassName } from '@tmex/ui/tabs';

export interface GuideTabOption<T extends string> {
  value: T;
  label: string;
  testId: string;
}

export function GuideTabs<T extends string>({
  value,
  onValueChange,
  options,
  fullWidth = false,
}: {
  value: T;
  onValueChange: (next: T) => void;
  options: GuideTabOption<T>[];
  fullWidth?: boolean;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onValueChange(next as T)}>
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
    </Tabs>
  );
}
