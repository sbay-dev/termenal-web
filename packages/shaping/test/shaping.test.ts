import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  loadFont,
  shapeRun,
  hasFullCoverage,
  totalAdvance,
  type ShapedGlyph,
} from '../src/index.js';

// Real shaping is font-dependent. These fonts ship with Windows; when absent
// (e.g. Linux CI) the font-backed cases are skipped, but the pure helpers below
// always run. The bytes are read here only to feed the browser-pure wrapper,
// which itself never touches the filesystem.
const ARABIC_FONT = 'C:\\Windows\\Fonts\\trado.ttf'; // Traditional Arabic
const MONO_FONT = 'C:\\Windows\\Fonts\\consola.ttf'; // Consolas (terminal face)
const hasArabic = existsSync(ARABIC_FONT);
const hasMono = existsSync(MONO_FONT);

function fontBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

describe('shapeRun — Arabic contextual joining (parity with the fork standard)', () => {
  it.skipIf(!hasArabic)('joins letters: word forms differ from isolated forms', () => {
    const font = loadFont(fontBytes(ARABIC_FONT));
    const word = 'كتب'; // kaf-taa-baa: initial + medial + final when joined
    const wordGlyphs = shapeRun(font, word, { direction: 'rtl', script: 'Arab' });

    expect(hasFullCoverage(wordGlyphs)).toBe(true);

    const chars = [...word];
    let changed = 0;
    chars.forEach((ch, i) => {
      const isolated = shapeRun(font, ch, { direction: 'rtl', script: 'Arab' });
      const inWord = wordGlyphs.find((g) => g.cluster === i);
      if (inWord && isolated[0] && isolated[0].glyphId !== inWord.glyphId) {
        changed += 1;
      }
    });
    // At least the initial + final letters must change shape when joined.
    expect(changed).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(!hasArabic)('applies the mandatory lam-alef ligature (2 code units -> 1 glyph)', () => {
    const font = loadFont(fontBytes(ARABIC_FONT));
    const ligature = shapeRun(font, 'لا', { direction: 'rtl', script: 'Arab' });
    expect(hasFullCoverage(ligature)).toBe(true);
    expect(ligature.length).toBeLessThan(2);
  });

  it.skipIf(!hasArabic)('shapes a full RTL row into a positioned glyph stream', () => {
    const font = loadFont(fontBytes(ARABIC_FONT));
    const glyphs = shapeRun(font, 'مرحبا بالعالم', { direction: 'rtl', script: 'Arab' });
    expect(glyphs.length).toBeGreaterThan(0);
    expect(hasFullCoverage(glyphs)).toBe(true);
    expect(totalAdvance(glyphs)).toBeGreaterThan(0);
    // Every glyph carries a cluster back into the logical input.
    expect(glyphs.every((g) => Number.isInteger(g.cluster))).toBe(true);
  });

  it.skipIf(!hasArabic)('exposes a positive unitsPerEm for advance normalisation', () => {
    const font = loadFont(fontBytes(ARABIC_FONT));
    expect(font.unitsPerEm).toBeGreaterThan(0);
  });
});

describe('shapeRun — font fallback requirement (D-6)', () => {
  it.skipIf(!hasMono)('the monospace terminal face lacks Arabic coverage', () => {
    const mono = loadFont(fontBytes(MONO_FONT));
    const glyphs = shapeRun(mono, 'كتب', { direction: 'rtl', script: 'Arab' });
    // Consolas has no Arabic glyphs -> notdef -> confirms a fallback chain is needed.
    expect(hasFullCoverage(glyphs)).toBe(false);
  });

  it.skipIf(!hasMono)('shapes LTR Latin with full coverage and positive advance', () => {
    const mono = loadFont(fontBytes(MONO_FONT));
    const glyphs = shapeRun(mono, 'ls -la /home', { direction: 'ltr', script: 'Latn' });
    expect(hasFullCoverage(glyphs)).toBe(true);
    expect(totalAdvance(glyphs)).toBeGreaterThan(0);
  });
});

describe('pure helpers (no font required)', () => {
  const g = (glyphId: number, xAdvance: number): ShapedGlyph => ({
    glyphId,
    cluster: 0,
    xAdvance,
    yAdvance: 0,
    xOffset: 0,
    yOffset: 0,
    flags: 0,
  });

  it('hasFullCoverage is false for empty and for any .notdef', () => {
    expect(hasFullCoverage([])).toBe(false);
    expect(hasFullCoverage([g(0, 10)])).toBe(false);
    expect(hasFullCoverage([g(5, 10), g(7, 12)])).toBe(true);
  });

  it('totalAdvance sums horizontal advances', () => {
    expect(totalAdvance([])).toBe(0);
    expect(totalAdvance([g(1, 10), g(2, 5)])).toBe(15);
  });
});
