// 公开面：与 dialog-impl 同名同签名，实现随 chunk 按需到货（见 ../lazy-overlay）。

'use client';

import type { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
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
const useDialogImpl = () => useContext(GateContext).impl ?? overlayLoader.peek();

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  const { gate, forceOpen, showFallback } = useOverlayGate(
    overlayLoader,
    props.open === true || props.defaultOpen === true
  );
  const Impl = gate.impl?.Dialog;
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

function DialogTrigger({ render, ...props }: DialogPrimitive.Trigger.Props) {
  const gate = useContext(GateContext);
  const handoff = useTriggerHandoff(props.id);
  const Impl = (gate.impl ?? overlayLoader.peek())?.DialogTrigger;
  if (Impl) return <Impl render={render} {...props} id={handoff.id} ref={handoff.adopt} />;
  return (
    <OverlayTrigger
      slot="dialog-trigger"
      semantics={DIALOG_TRIGGER_SEMANTICS}
      handoff={handoff}
      render={render}
      props={props as Record<string, unknown>}
      onActivate={gate.requestLoad}
      onOpen={gate.requestOpen}
    />
  );
}

const DialogPortal = createOverlayPart(useDialogImpl, 'DialogPortal');
const DialogClose = createOverlayPart(useDialogImpl, 'DialogClose');
const DialogOverlay = createOverlayPart(useDialogImpl, 'DialogOverlay');
const DialogContent = createOverlayPart(useDialogImpl, 'DialogContent');
const DialogHeader = createOverlayPart(useDialogImpl, 'DialogHeader');
const DialogFooter = createOverlayPart(useDialogImpl, 'DialogFooter');
const DialogTitle = createOverlayPart(useDialogImpl, 'DialogTitle');
const DialogDescription = createOverlayPart(useDialogImpl, 'DialogDescription');

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
