// 行内名称编辑的「定局」逻辑：一次编辑只能有一个结果（提交或取消），先到先得。
// 抽成纯函数是因为顺序很要紧——Esc / Enter 之后把焦点还给列表会同步触发 blur，
// 必须先定局再挪焦点，随后那次 blur 才不会把 Esc 变成提交。

export interface NameEditSession {
  settled: boolean;
}

export interface NameEditRequest {
  /** true = 想提交（Enter / 失焦），false = 取消（Esc / 名称非法时失焦） */
  commit: boolean;
  value: string;
  initialName: string;
  /** 名称没改也照样提交（新建文件夹用默认名） */
  commitUnchanged: boolean;
}

export interface NameEditHandlers {
  onCommit(name: string): void;
  onCancel(): void;
}

export function createNameEditSession(): NameEditSession {
  return { settled: false };
}

/** 已定局则什么都不做并返回 false；否则按请求调用一次 onCommit / onCancel 并返回 true。 */
export function settleNameEdit(
  session: NameEditSession,
  request: NameEditRequest,
  handlers: NameEditHandlers
): boolean {
  if (session.settled) return false;
  session.settled = true;
  const changed = request.value !== request.initialName;
  if (request.commit && (request.commitUnchanged || changed)) handlers.onCommit(request.value);
  else handlers.onCancel();
  return true;
}
