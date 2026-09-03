// 公开面：与 alert-dialog-impl 同名同签名，实现随 chunk 按需到货（见 ../lazy-overlay）。

'use client';

import type { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
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
const useAlertDialogImpl = () => useContext(GateContext).impl ?? overlayLoader.peek();

function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
  const { gate, forceOpen, showFallback } = useOverlayGate(
    overlayLoader,
    props.open === true || props.defaultOpen === true
  );
  const Impl = gate.impl?.AlertDialog;
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

function AlertDialogTrigger({ render, ...props }: AlertDialogPrimitive.Trigger.Props) {
  const gate = useContext(GateContext);
  const handoff = useTriggerHandoff(props.id);
  const Impl = (gate.impl ?? overlayLoader.peek())?.AlertDialogTrigger;
  if (Impl) return <Impl render={render} {...props} id={handoff.id} ref={handoff.adopt} />;
  return (
    <OverlayTrigger
      slot="alert-dialog-trigger"
      semantics={DIALOG_TRIGGER_SEMANTICS}
      handoff={handoff}
      render={render}
      props={props as Record<string, unknown>}
      onActivate={gate.requestLoad}
      onOpen={gate.requestOpen}
    />
  );
}

const AlertDialogPortal = createOverlayPart(useAlertDialogImpl, 'AlertDialogPortal');
const AlertDialogOverlay = createOverlayPart(useAlertDialogImpl, 'AlertDialogOverlay');
const AlertDialogContent = createOverlayPart(useAlertDialogImpl, 'AlertDialogContent');
const AlertDialogHeader = createOverlayPart(useAlertDialogImpl, 'AlertDialogHeader');
const AlertDialogFooter = createOverlayPart(useAlertDialogImpl, 'AlertDialogFooter');
const AlertDialogMedia = createOverlayPart(useAlertDialogImpl, 'AlertDialogMedia');
const AlertDialogTitle = createOverlayPart(useAlertDialogImpl, 'AlertDialogTitle');
const AlertDialogDescription = createOverlayPart(useAlertDialogImpl, 'AlertDialogDescription');
const AlertDialogAction = createOverlayPart(useAlertDialogImpl, 'AlertDialogAction');
const AlertDialogCancel = createOverlayPart(useAlertDialogImpl, 'AlertDialogCancel');

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
