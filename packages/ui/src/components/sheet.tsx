// 公开面：与 sheet-impl 同名同签名，实现随 chunk 按需到货（见 ../lazy-overlay）。

'use client';

import type { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
import { createContext, useContext } from 'react';

import {
  DIALOG_TRIGGER_SEMANTICS,
  OverlayLoadFallback,
  OverlayTrigger,
  createOverlayPart,
  overlayClosedChildren,
  useOverlayGate,
  useTriggerHandoff,
} from '../lazy-overlay';
import { NO_OVERLAY_GATE, overlayLoader } from '../overlay-impl-loader';

const GateContext = createContext(NO_OVERLAY_GATE);
// 没有外层 Root 时（部件被单独渲染，属误用）回落到模块级缓存，让 base-ui 照常抛出
// 「must be used within …」——这条契约不该因为懒加载而消失。
const useSheetImpl = () => useContext(GateContext).impl ?? overlayLoader.peek();

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  const { gate, forceOpen, showFallback } = useOverlayGate(
    overlayLoader,
    props.open === true || props.defaultOpen === true
  );
  const Impl = gate.impl?.Sheet;
  return (
    <GateContext.Provider value={gate}>
      {Impl ? (
        <Impl {...props} defaultOpen={forceOpen || props.defaultOpen} />
      ) : (
        <>
          {overlayClosedChildren(props.children)}
          {showFallback && <OverlayLoadFallback onRetry={gate.retry} />}
        </>
      )}
    </GateContext.Provider>
  );
}

function SheetTrigger({ render, ...props }: SheetPrimitive.Trigger.Props) {
  const gate = useContext(GateContext);
  const handoff = useTriggerHandoff(props.id);
  const Impl = (gate.impl ?? overlayLoader.peek())?.SheetTrigger;
  if (Impl) return <Impl render={render} {...props} id={handoff.id} ref={handoff.adopt} />;
  return (
    <OverlayTrigger
      slot="sheet-trigger"
      semantics={DIALOG_TRIGGER_SEMANTICS}
      handoff={handoff}
      render={render}
      props={props as Record<string, unknown>}
      onActivate={gate.requestLoad}
      onOpen={gate.requestOpen}
    />
  );
}

const SheetClose = createOverlayPart(useSheetImpl, 'SheetClose');
const SheetContent = createOverlayPart(useSheetImpl, 'SheetContent');
const SheetHeader = createOverlayPart(useSheetImpl, 'SheetHeader');
const SheetFooter = createOverlayPart(useSheetImpl, 'SheetFooter');
const SheetTitle = createOverlayPart(useSheetImpl, 'SheetTitle');
const SheetDescription = createOverlayPart(useSheetImpl, 'SheetDescription');

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
