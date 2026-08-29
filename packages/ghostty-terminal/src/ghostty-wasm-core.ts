import {
  type GhosttyExports,
  type LayoutField,
  type LayoutMap,
  WASM_USIZE_BYTES,
} from './ghostty-wasm-abi';

export class StructAllocation {
  constructor(
    private readonly bindings: GhosttyBindingsCore,
    readonly typeName: string,
    readonly ptr: number
  ) {}

  get view(): DataView {
    return this.bindings.view(this.ptr, this.bindings.typeSize(this.typeName));
  }

  free(): void {
    this.bindings.freeBytes(this.ptr, this.bindings.typeSize(this.typeName));
  }
}

export class GhosttyBindingsCore {
  readonly exports: GhosttyExports;
  readonly layout: LayoutMap;

  private readonly decoder = new TextDecoder();
  protected readonly encoder = new TextEncoder();

  constructor(exports: GhosttyExports, layout: LayoutMap) {
    this.exports = exports;
    this.layout = layout;
  }

  buffer(): ArrayBuffer {
    return this.exports.memory.buffer;
  }

  bytes(ptr = 0, len = this.buffer().byteLength - ptr): Uint8Array {
    return new Uint8Array(this.buffer(), ptr, len);
  }

  view(ptr = 0, len = this.buffer().byteLength - ptr): DataView {
    return new DataView(this.buffer(), ptr, len);
  }

  typeSize(typeName: string): number {
    const type = this.layout[typeName];
    if (!type) {
      throw new Error(`unknown ghostty type: ${typeName}`);
    }

    return type.size;
  }

  field(typeName: string, fieldName: string): LayoutField {
    const type = this.layout[typeName];
    const field = type?.fields[fieldName];
    if (!type || !field) {
      throw new Error(`unknown ghostty field: ${typeName}.${fieldName}`);
    }

    return field;
  }

  allocStruct(typeName: string): StructAllocation {
    const ptr = this.allocBytes(this.typeSize(typeName));
    this.bytes(ptr, this.typeSize(typeName)).fill(0);
    return new StructAllocation(this, typeName, ptr);
  }

  allocBytes(len: number): number {
    return this.exports.ghostty_wasm_alloc_u8_array(len);
  }

  freeBytes(ptr: number, len: number): void {
    this.exports.ghostty_wasm_free_u8_array(ptr, len);
  }

  allocOpaque(): number {
    return this.exports.ghostty_wasm_alloc_opaque();
  }

  freeOpaque(ptr: number): void {
    this.exports.ghostty_wasm_free_opaque(ptr);
  }

  allocU8(): number {
    return this.exports.ghostty_wasm_alloc_u8();
  }

  freeU8(ptr: number): void {
    this.exports.ghostty_wasm_free_u8(ptr);
  }

  allocUsize(): number {
    return this.exports.ghostty_wasm_alloc_usize();
  }

  freeUsize(ptr: number): void {
    this.exports.ghostty_wasm_free_usize(ptr);
  }

  readPointer(ptr: number): number {
    return this.view().getUint32(ptr, true);
  }

  readU8(ptr: number): number {
    return this.view().getUint8(ptr);
  }

  readUsize(ptr: number): number {
    if (WASM_USIZE_BYTES === 4) {
      return this.view().getUint32(ptr, true);
    }

    return Number(this.view().getBigUint64(ptr, true));
  }

  readU64(ptr: number): bigint {
    return this.view().getBigUint64(ptr, true);
  }

  setField(target: DataView, typeName: string, fieldName: string, value: number | boolean): void {
    const field = this.field(typeName, fieldName);
    const offset = field.offset;

    switch (field.type) {
      case 'u8':
      case 'bool':
        target.setUint8(offset, Number(value));
        return;
      case 'u16':
        target.setUint16(offset, Number(value), true);
        return;
      case 'u32':
        target.setUint32(offset, Number(value), true);
        return;
      case 'u64':
        target.setBigUint64(offset, BigInt(value), true);
        return;
      case 'usize':
        if (WASM_USIZE_BYTES === 4) {
          target.setUint32(offset, Number(value), true);
          return;
        }

        target.setBigUint64(offset, BigInt(value), true);
        return;
      case 'i32':
      case 'enum':
        target.setInt32(offset, Number(value), true);
        return;
      default:
        throw new Error(`unsupported field type ${typeName}.${fieldName}: ${field.type}`);
    }
  }

  writeString(data: string): { ptr: number; len: number; free: () => void } {
    const encoded = this.encoder.encode(data);
    const ptr = this.allocBytes(encoded.length);
    this.bytes(ptr, encoded.length).set(encoded);

    return {
      ptr,
      len: encoded.length,
      free: () => this.freeBytes(ptr, encoded.length),
    };
  }

  writeBytes(data: Uint8Array): { ptr: number; len: number; free: () => void } {
    const ptr = this.allocBytes(data.length);
    this.bytes(ptr, data.length).set(data);

    return {
      ptr,
      len: data.length,
      free: () => this.freeBytes(ptr, data.length),
    };
  }

  readOwnedUtf8(ptr: number, len: number): string {
    return this.decoder.decode(this.bytes(ptr, len));
  }
}
