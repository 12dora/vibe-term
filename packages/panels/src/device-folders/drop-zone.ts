// 注册一个落点区，并顺带给出它在 DOM 上的标记。
//
// `useDroppable` 只给一个 ref，渲染出来的 HTML 上看不出落点到底注册没注册；把 ref 与
// `data-drop-zone` 属性从同一个调用里一起交出去，标记就成了「这里确实注册了落点」的证据，
// 静态渲染的测试据此断言（删掉这次调用，属性也就跟着没了）。

import { useDroppable } from '@dnd-kit/core';
import { useMemo } from 'react';

export interface DropZoneBinding {
  ref: (element: HTMLElement | null) => void;
  /** 摊到落点元素上：`<div ref={zone.ref} {...zone.props} />` */
  props: { 'data-drop-zone': string };
}

export function useDropZone(zoneId: string): DropZoneBinding {
  const { setNodeRef } = useDroppable({ id: zoneId });
  return useMemo(
    () => ({ ref: setNodeRef, props: { 'data-drop-zone': zoneId } }),
    [setNodeRef, zoneId]
  );
}
