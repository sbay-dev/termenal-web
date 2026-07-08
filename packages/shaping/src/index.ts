// @termenal-web/shaping
//
// OpenType text shaping via HarfBuzz compiled to WebAssembly (`harfbuzzjs`).
// This is the piece xterm.js lacks: Arabic contextual joining
// (initial/medial/final forms) and ligatures (e.g. lam-alef), driven by the
// font's GSUB/GPOS tables. Implements directive D-1.
//
// Browser-pure: the module takes font *bytes* (fetched via fetch() in the
// browser or read from disk in Node tests); it never touches the filesystem.
// `harfbuzzjs` initialises its WASM module via a top-level await, so importing
// this module is enough — no async init step is required by callers.

import * as hb from 'harfbuzzjs';

/** Logical writing direction of a single shaped run. */
export type ShapingDirection = 'ltr' | 'rtl';

/**
 * ISO 15924 script tag (e.g. `'Arab'`, `'Latn'`, `'Hebr'`). When omitted,
 * HarfBuzz guesses the script from the run's text.
 */
export type ScriptTag = string;

/** A single positioned glyph produced by shaping. */
export interface ShapedGlyph {
  /**
   * Glyph index in the font (NOT a Unicode code point). After shaping,
   * HarfBuzz reports the resolved glyph id here — this is the contextual
   * (joined) form for Arabic, and the ligature glyph for merged clusters.
   */
  glyphId: number;
  /**
   * Cluster value: the UTF-16 code-unit offset in the input `text` that this
   * glyph originates from. Multiple glyphs can share a cluster (decomposition)
   * and multiple code units can collapse into one cluster (ligature). Matches
   * the UTF-16 indexing used by `@termenal-web/bidi`.
   */
  cluster: number;
  /** Horizontal advance, in font design units (scale by `unitsPerEm`). */
  xAdvance: number;
  /** Vertical advance, in font design units (0 for horizontal scripts). */
  yAdvance: number;
  /** Horizontal positioning offset, in font design units. */
  xOffset: number;
  /** Vertical positioning offset, in font design units. */
  yOffset: number;
  /** HarfBuzz glyph flags (e.g. UNSAFE_TO_BREAK); see {@link hb.GlyphFlag}. */
  flags: number;
}

/** Options controlling how a run is shaped. */
export interface ShapeOptions {
  /**
   * Explicit run direction. Strongly recommended: the caller resolves this
   * from `@termenal-web/bidi` per bidi run. When omitted, HarfBuzz guesses it
   * from the text (correct for pure-script runs, ambiguous for mixed text).
   */
  direction?: ShapingDirection;
  /** Explicit script tag (e.g. `'Arab'`). When omitted, HarfBuzz guesses it. */
  script?: ScriptTag;
  /** BCP-47 language tag (e.g. `'ar'`). Rarely needed; affects a few features. */
  language?: string;
  /** Optional raw HarfBuzz features to force/disable (advanced). */
  features?: hb.Feature[];
}

/**
 * A font ready for shaping. Wraps the HarfBuzz blob/face/font trio. HarfBuzz
 * objects are reclaimed by a FinalizationRegistry when the wrapper is GC'd;
 * load a font once and reuse it across many `shapeRun` calls.
 */
export interface LoadedFont {
  /** The underlying HarfBuzz font (advanced use). */
  readonly font: hb.Font;
  /** The underlying HarfBuzz face (advanced use). */
  readonly face: hb.Face;
  /** Font units per em — divide design-unit advances by this to normalise. */
  readonly unitsPerEm: number;
  /** Human-readable glyph name for a glyph id (best effort, for debugging). */
  glyphName(glyphId: number): string;
}

// HarfBuzz direction enum is numeric (LTR = 4, RTL = 5). The value is passed
// straight through to the WASM export, so a string here would coerce to NaN /
// INVALID and silently leave the buffer unshaped — always use these constants.
const HB_DIRECTION: Readonly<Record<ShapingDirection, hb.Direction>> = {
  ltr: hb.Direction.LTR,
  rtl: hb.Direction.RTL,
};

/** HarfBuzz's `Blob` constructor wants a plain `ArrayBuffer`; normalise to one. */
function toArrayBuffer(data: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (data instanceof ArrayBuffer) {
    return data;
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

/**
 * Load a font from its binary contents for reuse across shaping calls.
 *
 * @param data Raw font file bytes (TTF/OTF). In the browser, obtain via
 *   `new Uint8Array(await (await fetch(url)).arrayBuffer())`.
 * @param faceIndex Face index within a collection file (0 for standalone fonts).
 */
export function loadFont(data: Uint8Array | ArrayBuffer, faceIndex = 0): LoadedFont {
  const blob = new hb.Blob(toArrayBuffer(data));
  const face = new hb.Face(blob, faceIndex);
  const font = new hb.Font(face);
  return {
    font,
    face,
    unitsPerEm: face.upem,
    glyphName(glyphId: number): string {
      try {
        return font.glyphName(glyphId) || `gid${glyphId}`;
      } catch {
        return `gid${glyphId}`;
      }
    },
  };
}

/**
 * Shape a single run of same-direction, same-script text into positioned
 * glyphs. The input must already be segmented into runs (by direction/script)
 * — this function does not perform bidi or itemisation.
 *
 * Correctness note: explicit `direction`/`script` are set BEFORE
 * `guessSegmentProperties`, which only fills properties the caller left unset.
 * This yields deterministic joining regardless of surrounding context.
 */
export function shapeRun(
  loaded: LoadedFont,
  text: string,
  options: ShapeOptions = {},
): ShapedGlyph[] {
  const buffer = new hb.Buffer();
  buffer.addText(text);

  if (options.direction) {
    buffer.setDirection(HB_DIRECTION[options.direction]);
  }
  if (options.script) {
    buffer.setScript(options.script);
  }
  if (options.language) {
    buffer.setLanguage(options.language);
  }
  // Fills only the properties left unset above (never overrides an explicit one).
  buffer.guessSegmentProperties();

  hb.shape(loaded.font, buffer, options.features);

  return buffer.getGlyphInfosAndPositions().map((g) => ({
    glyphId: g.codepoint,
    cluster: g.cluster,
    xAdvance: g.xAdvance ?? 0,
    yAdvance: g.yAdvance ?? 0,
    xOffset: g.xOffset ?? 0,
    yOffset: g.yOffset ?? 0,
    flags: g.flags,
  }));
}

/** True iff every glyph resolved to a real glyph (no `.notdef`/gid 0). */
export function hasFullCoverage(glyphs: readonly ShapedGlyph[]): boolean {
  return glyphs.length > 0 && glyphs.every((g) => g.glyphId !== 0);
}

/** Sum of horizontal advances of a shaped run, in font design units. */
export function totalAdvance(glyphs: readonly ShapedGlyph[]): number {
  let sum = 0;
  for (const g of glyphs) {
    sum += g.xAdvance;
  }
  return sum;
}

export { hb };
