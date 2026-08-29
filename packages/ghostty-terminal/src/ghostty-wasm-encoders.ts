import {
  GHOSTTY_KEY_ACTION_PRESS,
  GHOSTTY_KEY_ACTION_RELEASE,
  GHOSTTY_KEY_ACTION_REPEAT,
  GHOSTTY_MODE_ANY_MOUSE,
  GHOSTTY_MODE_BRACKETED_PASTE,
  GHOSTTY_MODE_BUTTON_MOUSE,
  GHOSTTY_MODE_NORMAL_MOUSE,
  GHOSTTY_MODE_SGR_MOUSE,
  GHOSTTY_MODE_SGR_PIXELS_MOUSE,
  GHOSTTY_MODE_URXVT_MOUSE,
  GHOSTTY_MODE_UTF8_MOUSE,
  GHOSTTY_MODE_X10_MOUSE,
  GHOSTTY_MOUSE_ENCODER_OPT_TRACK_LAST_CELL,
  assertResult,
} from './ghostty-wasm-abi';
import { GhosttyBindingsRenderState } from './ghostty-wasm-render-state';
import { encodeOwnedUtf8Output } from './wasm-output-marshalling';

type GhosttyMouseEncodeOptions = {
  action: 'press' | 'release' | 'motion';
  button?: number | null;
  mods: number;
  x: number;
  y: number;
  anyButtonPressed: boolean;
  screenWidth: number;
  screenHeight: number;
  cellWidth: number;
  cellHeight: number;
};

function encodeMouseModifierBits(mods: number): number {
  let encoded = 0;
  if (mods & (1 << 0)) encoded += 4;
  if (mods & (1 << 2)) encoded += 8;
  if (mods & (1 << 1)) encoded += 16;
  return encoded;
}

function encodeX10Byte(value: number): string | null {
  if (value < 0 || value > 223) {
    return null;
  }

  return String.fromCharCode(value + 32);
}

function mouseButtonCode(button: number | null | undefined): number | null {
  switch (button) {
    case 1:
      return 0;
    case 3:
      return 1;
    case 2:
      return 2;
    case 4:
      return 64;
    case 5:
      return 65;
    case 6:
      return 66;
    case 7:
      return 67;
    case 8:
      return 128;
    case 9:
      return 129;
    case null:
    case undefined:
      return 3;
    default:
      return null;
  }
}

export function keyboardEventToGhosttyMods(event: KeyboardEvent): number {
  let mods = 0;

  if (event.shiftKey) mods |= 1 << 0;
  if (event.ctrlKey) mods |= 1 << 1;
  if (event.altKey) mods |= 1 << 2;
  if (event.metaKey) mods |= 1 << 3;
  if (event.getModifierState?.('CapsLock')) mods |= 1 << 4;
  if (event.getModifierState?.('NumLock')) mods |= 1 << 5;

  return mods;
}

export class GhosttyBindingsEncoders extends GhosttyBindingsRenderState {
  createKeyEncoder(): number {
    const outEncoderPtr = this.allocOpaque();

    try {
      assertResult(
        this.exports.ghostty_key_encoder_new(0, outEncoderPtr),
        'ghostty_key_encoder_new'
      );
      return this.readPointer(outEncoderPtr);
    } finally {
      this.freeOpaque(outEncoderPtr);
    }
  }

  freeKeyEncoder(encoder: number): void {
    this.exports.ghostty_key_encoder_free(encoder);
  }

  createMouseEncoder(): number {
    const outEncoderPtr = this.allocOpaque();
    const trackLastCellPtr = this.allocU8();

    try {
      assertResult(
        this.exports.ghostty_mouse_encoder_new(0, outEncoderPtr),
        'ghostty_mouse_encoder_new'
      );
      const encoder = this.readPointer(outEncoderPtr);
      this.view().setUint8(trackLastCellPtr, 1);
      this.exports.ghostty_mouse_encoder_setopt(
        encoder,
        GHOSTTY_MOUSE_ENCODER_OPT_TRACK_LAST_CELL,
        trackLastCellPtr
      );
      return encoder;
    } finally {
      this.freeU8(trackLastCellPtr);
      this.freeOpaque(outEncoderPtr);
    }
  }

  freeMouseEncoder(encoder: number): void {
    this.exports.ghostty_mouse_encoder_free(encoder);
  }

  resetMouseEncoder(encoder: number): void {
    this.exports.ghostty_mouse_encoder_reset(encoder);
  }

  encodeMouseEvent(
    encoder: number,
    terminal: number,
    options: GhosttyMouseEncodeOptions
  ): string | null {
    void encoder;

    const trackingAny = this.isTerminalModeEnabled(terminal, GHOSTTY_MODE_ANY_MOUSE);
    const trackingButton = this.isTerminalModeEnabled(terminal, GHOSTTY_MODE_BUTTON_MOUSE);
    const trackingNormal = this.isTerminalModeEnabled(terminal, GHOSTTY_MODE_NORMAL_MOUSE);
    const trackingX10 = this.isTerminalModeEnabled(terminal, GHOSTTY_MODE_X10_MOUSE);

    if (!trackingAny && !trackingButton && !trackingNormal && !trackingX10) {
      return null;
    }

    if (
      options.action === 'motion' &&
      !(trackingAny || (trackingButton && options.anyButtonPressed))
    ) {
      return null;
    }

    if (trackingX10 && options.action !== 'press') {
      return null;
    }

    if (!trackingAny && !trackingButton && !trackingX10 && options.action === 'motion') {
      return null;
    }

    const baseCode = mouseButtonCode(options.button);
    if (baseCode === null) {
      return null;
    }

    const column = Math.max(1, Math.floor(options.x / Math.max(1, options.cellWidth)) + 1);
    const row = Math.max(1, Math.floor(options.y / Math.max(1, options.cellHeight)) + 1);
    const pixelX = Math.round(options.x + 1);
    const pixelY = Math.round(options.y + 1);

    let code =
      options.action === 'release' &&
      !this.isTerminalModeEnabled(terminal, GHOSTTY_MODE_SGR_MOUSE) &&
      !this.isTerminalModeEnabled(terminal, GHOSTTY_MODE_SGR_PIXELS_MOUSE)
        ? 3
        : baseCode;

    if (options.action === 'motion') {
      code += 32;
    }

    code += encodeMouseModifierBits(options.mods);

    if (this.isTerminalModeEnabled(terminal, GHOSTTY_MODE_SGR_PIXELS_MOUSE)) {
      const suffix = options.action === 'release' ? 'm' : 'M';
      return `\u001b[<${code};${pixelX};${pixelY}${suffix}`;
    }

    if (this.isTerminalModeEnabled(terminal, GHOSTTY_MODE_SGR_MOUSE)) {
      const suffix = options.action === 'release' ? 'm' : 'M';
      return `\u001b[<${code};${column};${row}${suffix}`;
    }

    if (this.isTerminalModeEnabled(terminal, GHOSTTY_MODE_URXVT_MOUSE)) {
      return `\u001b[${code};${column};${row}M`;
    }

    if (
      this.isTerminalModeEnabled(terminal, GHOSTTY_MODE_UTF8_MOUSE) ||
      trackingNormal ||
      trackingButton ||
      trackingAny ||
      trackingX10
    ) {
      const encodedCode = encodeX10Byte(code);
      const encodedColumn = encodeX10Byte(column);
      const encodedRow = encodeX10Byte(row);
      if (!encodedCode || !encodedColumn || !encodedRow) {
        return null;
      }
      return `\u001b[M${encodedCode}${encodedColumn}${encodedRow}`;
    }

    return null;
  }

  encodeKeyEvent(
    encoder: number,
    terminal: number,
    options: {
      action: 'press' | 'repeat' | 'release';
      keyCode: number;
      mods: number;
      composing: boolean;
      utf8?: string | null;
      unshiftedCodepoint?: number | null;
    }
  ): string | null {
    if (options.keyCode <= 0) {
      return null;
    }

    const eventPtrPtr = this.allocOpaque();
    let eventHandle = 0;
    let utf8Allocation: { ptr: number; len: number; free: () => void } | null = null;

    try {
      assertResult(this.exports.ghostty_key_event_new(0, eventPtrPtr), 'ghostty_key_event_new');
      eventHandle = this.readPointer(eventPtrPtr);
      this.exports.ghostty_key_encoder_setopt_from_terminal(encoder, terminal);
      this.exports.ghostty_key_event_set_action(
        eventHandle,
        options.action === 'release'
          ? GHOSTTY_KEY_ACTION_RELEASE
          : options.action === 'repeat'
            ? GHOSTTY_KEY_ACTION_REPEAT
            : GHOSTTY_KEY_ACTION_PRESS
      );
      this.exports.ghostty_key_event_set_key(eventHandle, options.keyCode);
      this.exports.ghostty_key_event_set_mods(eventHandle, options.mods);
      this.exports.ghostty_key_event_set_consumed_mods(eventHandle, 0);
      this.exports.ghostty_key_event_set_composing(eventHandle, options.composing ? 1 : 0);

      if (options.utf8) {
        utf8Allocation = this.writeString(options.utf8);
        this.exports.ghostty_key_event_set_utf8(
          eventHandle,
          utf8Allocation.ptr,
          utf8Allocation.len
        );
      }

      if (typeof options.unshiftedCodepoint === 'number') {
        this.exports.ghostty_key_event_set_unshifted_codepoint(
          eventHandle,
          options.unshiftedCodepoint
        );
      }

      return this.encodeKeyHandle(encoder, eventHandle);
    } finally {
      utf8Allocation?.free();
      if (eventHandle !== 0) {
        this.exports.ghostty_key_event_free(eventHandle);
      }
      this.freeOpaque(eventPtrPtr);
    }
  }

  private encodeKeyHandle(encoder: number, eventHandle: number): string | null {
    return encodeOwnedUtf8Output(this, {
      label: 'ghostty_key_encoder_encode',
      assertResult,
      encode: (outPtr, capacity, writtenPtr) =>
        this.exports.ghostty_key_encoder_encode(encoder, eventHandle, outPtr, capacity, writtenPtr),
    });
  }

  encodePaste(terminal: number, data: string): string {
    const input = this.writeString(data);

    try {
      const bracketed = this.isTerminalModeEnabled(terminal, GHOSTTY_MODE_BRACKETED_PASTE);
      return (
        encodeOwnedUtf8Output(this, {
          label: 'ghostty_paste_encode',
          assertResult,
          encode: (outPtr, capacity, writtenPtr) =>
            this.exports.ghostty_paste_encode(
              input.ptr,
              input.len,
              bracketed ? 1 : 0,
              outPtr,
              capacity,
              writtenPtr
            ),
        }) ?? ''
      );
    } finally {
      input.free();
    }
  }
}
