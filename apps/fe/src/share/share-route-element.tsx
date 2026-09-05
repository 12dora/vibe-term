// `/s/:shareId` 的路由元素：只负责把分享页 chunk 拉下来。
//
// 不复用 `PageWrapper`：那层顶栏带品牌链接与侧栏开关，且页标题/动作区只吃路由参数，
// 而分享页的名称与剩余期限来自接口。分享页自带完整外壳，这里保持极薄，
// 免得把它的依赖拽进入口 chunk。

import { PageLoadFallback } from '@/PageLoadFallback';
import { sharePageModule } from '@/page-modules';
import { usePageModule } from '@/use-page-module';

export function ShareRouteElement() {
  const { state, retry } = usePageModule(sharePageModule);
  if (state.status === 'error') return <PageLoadFallback onRetry={retry} />;
  const Page = state.status === 'ready' ? state.module.default : null;
  return Page ? <Page /> : null;
}
