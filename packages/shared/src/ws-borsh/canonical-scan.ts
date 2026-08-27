// 规范编码校验：按 schema 单遍扫描原始字节，替代「反序列化后再序列化逐字节比对」。
// 等价性依据：除 bool / option tag / string(UTF-8) 外，Borsh 各节点读写均为双射，
// 因此「payload 是其解码值的规范编码」等价于「逐节点满足下列约束且无尾随字节」。
// schema 结构静态不变，首次使用时编译为扫描闭包并按 schema 对象缓存。

import { ERROR_INVALID_FRAME, WsBorshError } from './errors';

export interface CanonicalSchemaNode {
  readonly type: string;
  readonly options: unknown;
}

type ScanStep = (cursor: PayloadCursor) => void;
type ScanCompiler = (options: unknown) => ScanStep;

function invalid(message: string): never {
  throw new WsBorshError(ERROR_INVALID_FRAME, false, message);
}

class PayloadCursor {
  offset = 0;

  constructor(readonly payload: Uint8Array) {}

  get remaining(): number {
    return this.payload.byteLength - this.offset;
  }

  skip(count: number): number {
    const start = this.offset;
    if (count < 0 || count > this.remaining) invalid('canonical payload truncated');
    this.offset = start + count;
    return start;
  }

  readU8(): number {
    return this.payload[this.skip(1)];
  }

  readU32(): number {
    const start = this.skip(4);
    const bytes = this.payload;
    return (
      (bytes[start] |
        (bytes[start + 1] << 8) |
        (bytes[start + 2] << 16) |
        (bytes[start + 3] << 24)) >>>
      0
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('canonical schema node options must be an object');
  }
  return value as Record<string, unknown>;
}

function asNode(value: unknown): CanonicalSchemaNode {
  const record = asRecord(value);
  if (typeof record.type !== 'string') {
    throw new Error('canonical schema node is missing its type');
  }
  return { type: record.type, options: record.options };
}

function childNode(options: unknown, typeKey: string, optionsKey: string): CanonicalSchemaNode {
  const record = asRecord(options);
  return asNode({ type: record[typeKey], options: record[optionsKey] });
}

function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

function leadContinuationRange(lead: number): readonly [number, number] {
  if (lead === 0xe0) return [0xa0, 0xbf];
  if (lead === 0xed) return [0x80, 0x9f];
  if (lead === 0xf0) return [0x90, 0xbf];
  if (lead === 0xf4) return [0x80, 0x8f];
  return [0x80, 0xbf];
}

function isWellFormedUtf8(bytes: Uint8Array, start: number, end: number): boolean {
  let index = start;
  while (index < end) {
    const lead = bytes[index];
    const length = utf8SequenceLength(lead);
    if (length === 0 || index + length > end) return false;
    const [first, last] = leadContinuationRange(lead);
    for (let offset = 1; offset < length; offset += 1) {
      const byte = bytes[index + offset];
      const lower = offset === 1 ? first : 0x80;
      const upper = offset === 1 ? last : 0xbf;
      if (byte < lower || byte > upper) return false;
    }
    index += length;
  }
  return true;
}

function scanString(cursor: PayloadCursor): void {
  const length = cursor.readU32();
  const start = cursor.skip(length);
  if (!isWellFormedUtf8(cursor.payload, start, start + length)) {
    invalid('non-canonical string encoding');
  }
}

function scanBool(cursor: PayloadCursor): void {
  if (cursor.readU8() > 1) invalid('non-canonical bool encoding');
}

function skipStep(count: number): ScanStep {
  return (cursor) => {
    cursor.skip(count);
  };
}

function compileBytes(options: unknown): ScanStep {
  const fixedLength = asRecord(options).length;
  if (typeof fixedLength === 'number') return skipStep(fixedLength);
  return (cursor) => {
    cursor.skip(cursor.readU32());
  };
}

function compileOption(options: unknown): ScanStep {
  const value = compileNode(childNode(options, 'valueType', 'valueOptions'));
  return (cursor) => {
    const tag = cursor.readU8();
    if (tag > 1) invalid('non-canonical option tag');
    if (tag === 1) value(cursor);
  };
}

function compileVec(options: unknown): ScanStep {
  const element = compileNode(childNode(options, 'elementType', 'elementOptions'));
  return (cursor) => {
    const length = cursor.readU32();
    // canonical schema 中 vec 元素均至少占 1 字节，长度前缀超过剩余字节即非法
    if (length > cursor.remaining) invalid('canonical vector length exceeds payload');
    for (let index = 0; index < length; index += 1) element(cursor);
  };
}

function compileStruct(options: unknown): ScanStep {
  const fields = Object.values(asRecord(options)).map((field) => compileNode(asNode(field)));
  return (cursor) => {
    for (const field of fields) field(cursor);
  };
}

function compileEnum(options: unknown): ScanStep {
  const variants = asRecord(options).variants;
  if (!Array.isArray(variants)) throw new Error('canonical enum schema is missing variants');
  const steps = new Map<number, ScanStep>();
  for (const raw of variants) {
    const variant = asRecord(raw);
    if (typeof variant.index !== 'number') throw new Error('canonical enum variant lacks an index');
    steps.set(variant.index, compileNode(asNode(variant)));
  }
  return (cursor) => {
    const tag = cursor.readU8();
    const step = steps.get(tag);
    if (!step) invalid(`unknown canonical enum variant index ${tag}`);
    step(cursor);
  };
}

const COMPILERS: ReadonlyMap<string, ScanCompiler> = new Map<string, ScanCompiler>([
  ['unit', () => () => {}],
  ['u8', () => skipStep(1)],
  ['u16', () => skipStep(2)],
  ['u32', () => skipStep(4)],
  ['u64', () => skipStep(8)],
  ['bool', () => scanBool],
  ['string', () => scanString],
  ['bytes', compileBytes],
  ['option', compileOption],
  ['vec', compileVec],
  ['struct', compileStruct],
  ['enum', compileEnum],
]);

function compileNode(node: CanonicalSchemaNode): ScanStep {
  const compiler = COMPILERS.get(node.type);
  if (!compiler) throw new Error(`unsupported canonical schema node: ${node.type}`);
  return compiler(node.options);
}

const COMPILED = new WeakMap<CanonicalSchemaNode, ScanStep>();

function scanStepFor(schema: CanonicalSchemaNode): ScanStep {
  const cached = COMPILED.get(schema);
  if (cached) return cached;
  const step = compileNode(schema);
  COMPILED.set(schema, step);
  return step;
}

export function assertCanonicalEncoding(schema: CanonicalSchemaNode, payload: Uint8Array): void {
  const cursor = new PayloadCursor(payload);
  scanStepFor(schema)(cursor);
  if (cursor.offset !== payload.byteLength) invalid('trailing bytes after canonical payload');
}

export function canonicalScanSupportsNode(type: string): boolean {
  return COMPILERS.has(type);
}
