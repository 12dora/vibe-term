// 公开面：与 dropdown-menu-impl 同名同签名，实现随 chunk 按需到货（见 ../lazy-overlay）。
// 闭合态由占位触发器同步渲染；实现未到货时按下触发器，到货后直接以打开态挂载，
// 用户看到的仍是「按一下就开」。

'use client';

import type { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { createContext, useContext } from 'react';

import {
  MENU_TRIGGER_SEMANTICS,
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
const useDropdownMenuImpl = () => useContext(GateContext).impl ?? overlayLoader.peek();

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  const { gate, forceOpen, showFallback } = useOverlayGate(
    overlayLoader,
    props.open === true || props.defaultOpen === true
  );
  const Impl = gate.impl?.DropdownMenu;
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

function DropdownMenuTrigger({ render, ...props }: MenuPrimitive.Trigger.Props) {
  const gate = useContext(GateContext);
  const handoff = useTriggerHandoff(props.id);
  const Impl = (gate.impl ?? overlayLoader.peek())?.DropdownMenuTrigger;
  if (Impl) return <Impl render={render} {...props} id={handoff.id} ref={handoff.adopt} />;
  return (
    <OverlayTrigger
      slot="dropdown-menu-trigger"
      semantics={MENU_TRIGGER_SEMANTICS}
      handoff={handoff}
      render={render}
      props={props as Record<string, unknown>}
      onActivate={gate.requestLoad}
      onOpen={gate.requestOpen}
    />
  );
}

const DropdownMenuPortal = createOverlayPart(useDropdownMenuImpl, 'DropdownMenuPortal');
const DropdownMenuContent = createOverlayPart(useDropdownMenuImpl, 'DropdownMenuContent');
const DropdownMenuGroup = createOverlayPart(useDropdownMenuImpl, 'DropdownMenuGroup');
const DropdownMenuLabel = createOverlayPart(useDropdownMenuImpl, 'DropdownMenuLabel');
const DropdownMenuItem = createOverlayPart(useDropdownMenuImpl, 'DropdownMenuItem');
const DropdownMenuCheckboxItem = createOverlayPart(useDropdownMenuImpl, 'DropdownMenuCheckboxItem');
const DropdownMenuRadioGroup = createOverlayPart(useDropdownMenuImpl, 'DropdownMenuRadioGroup');
const DropdownMenuRadioItem = createOverlayPart(useDropdownMenuImpl, 'DropdownMenuRadioItem');
const DropdownMenuSeparator = createOverlayPart(useDropdownMenuImpl, 'DropdownMenuSeparator');
const DropdownMenuShortcut = createOverlayPart(useDropdownMenuImpl, 'DropdownMenuShortcut');
const DropdownMenuSub = createOverlayPart(useDropdownMenuImpl, 'DropdownMenuSub');
const DropdownMenuSubTrigger = createOverlayPart(useDropdownMenuImpl, 'DropdownMenuSubTrigger');
const DropdownMenuSubContent = createOverlayPart(useDropdownMenuImpl, 'DropdownMenuSubContent');

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
