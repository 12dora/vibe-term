// 公开面：与 tooltip-impl 同名同签名，实现随 chunk 按需到货（见 ../lazy-overlay）。
// 闭合态由占位触发器同步渲染，`data-slot="tooltip-trigger"` 与实现侧一致。

import type { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { type ComponentProps, createContext, useContext } from 'react';

import {
  type OverlayGate,
  OverlayTrigger,
  overlayClosedChildren,
  useOverlayGate,
} from '../lazy-overlay';
import { type OverlaysImpl, overlayLoader } from '../overlay-impl-loader';

const NO_GATE: OverlayGate<OverlaysImpl> = {
  impl: null,
  requestLoad: () => undefined,
  requestOpen: () => undefined,
};

const GateContext = createContext<OverlayGate<OverlaysImpl>>(NO_GATE);
// 没有外层 Root 时（部件被单独渲染，属误用）回落到模块级缓存，让 base-ui 照常抛出
// 「must be used within …」——这条契约不该因为懒加载而消失。
const useTooltipImpl = () => useContext(GateContext).impl ?? overlayLoader.peek();

function TooltipProvider({ children, ...props }: TooltipPrimitive.Provider.Props) {
  const { gate } = useOverlayGate(overlayLoader, false);
  const Impl = gate.impl?.TooltipProvider;
  if (!Impl) return <>{children}</>;
  return <Impl {...props}>{children}</Impl>;
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  const { gate } = useOverlayGate(overlayLoader, props.open === true || props.defaultOpen === true);
  const Impl = gate.impl?.Tooltip;
  return (
    <GateContext.Provider value={gate}>
      {Impl ? <Impl {...props} /> : overlayClosedChildren(props.children)}
    </GateContext.Provider>
  );
}

function TooltipTrigger({ render, ...props }: TooltipPrimitive.Trigger.Props) {
  const gate = useContext(GateContext);
  const Impl = (gate.impl ?? overlayLoader.peek())?.TooltipTrigger;
  if (Impl) return <Impl render={render} {...props} />;
  // tooltip 没有「按下即开」语义：指到/聚焦只是把加载提前，开合仍由 base-ui 的 hover 逻辑决定
  return (
    <OverlayTrigger
      slot="tooltip-trigger"
      render={render}
      props={props as Record<string, unknown>}
      onActivate={gate.requestLoad}
    />
  );
}

function TooltipContent(props: ComponentProps<OverlaysImpl['TooltipContent']>) {
  const Impl = useTooltipImpl()?.TooltipContent;
  if (!Impl) return null;
  return <Impl {...props} />;
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
