// 输入法组合态判定：候选词确认用的 Enter / Escape 不应被当成提交或取消。

export interface ImeKeyEventLike {
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

/** 兼容 React 合成事件与原生事件；Safari 在 compositionend 之后的那次 keydown 只有 keyCode 229。 */
export function isImeKeyEvent(event: ImeKeyEventLike): boolean {
  const native = event.nativeEvent ?? event;
  return native.isComposing === true || native.keyCode === 229 || event.keyCode === 229;
}
