// 语义化版本比较（前后端共享，浏览器安全：无 node 依赖）。
//
// 仅覆盖 `X.Y.Z` 与可选 `-prerelease`：网关自报的版本在开发态会带 `_dev` 后缀
// （见 formatDisplayVersion），这类字符串按「无法解析」处理，由调用方决定回退策略。

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;

export function parseSemver(input: string): Semver | null {
  const match = input.trim().match(SEMVER_PATTERN);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function comparePrerelease(left: string, right: string): number {
  const a = left.split('.');
  const b = right.split('.');
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = NUMERIC_IDENTIFIER.test(x);
    const yNumeric = NUMERIC_IDENTIFIER.test(y);
    if (xNumeric && yNumeric) {
      const xv = Number(x);
      const yv = Number(y);
      if (xv !== yv) return xv > yv ? 1 : -1;
      continue;
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** left 大于 right 返回 1，小于返回 -1，相等返回 0；任一侧无法解析返回 null。 */
export function compareSemver(left: string, right: string): number | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;

  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;

  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** 无法解析时抛错。调用方若要自定义文案，应先 `parseSemver` 再自行处理 null。 */
export function requireSemver(input: string): Semver {
  const parsed = parseSemver(input);
  if (!parsed) throw new Error(`invalid semver: ${input}`);
  return parsed;
}

/** 与 `compareSemver` 同序；任一侧无法解析时抛错。 */
export function compareSemverRequired(left: string, right: string): number {
  const result = compareSemver(left, right);
  if (result === null) throw new Error(`invalid semver: ${left} vs ${right}`);
  return result;
}
