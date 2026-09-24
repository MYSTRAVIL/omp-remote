import { renderUnicodeCompact } from "uqr";

/**
 * `text` as a terminal QR code: half-block characters, two module rows per
 * line. Light modules are drawn as blocks, so the code reads correctly on a
 * dark terminal; a two-module border gives cameras a quiet zone.
 */
export function renderQr(text: string): string {
  return renderUnicodeCompact(text, { border: 2 });
}
