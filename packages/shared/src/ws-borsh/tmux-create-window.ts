import { b } from '@zorsh/zorsh';

const optionalString = b.option(b.string());

const fields = {
  deviceId: b.string(),
  name: optionalString,
  cwd: optionalString,
};

/** 既有 `KIND_TMUX_CREATE_WINDOW` 载荷；不要加字段，旧网关 / 缓存 PWA 必须还能解。 */
export const TmuxCreateWindowSchema = b.struct(fields);

/** `KIND_TMUX_CREATE_WINDOW_DETACHED`：语义上等价 create-window + `new-window -d`。 */
export const TmuxCreateWindowDetachedSchema = b.struct(fields);
