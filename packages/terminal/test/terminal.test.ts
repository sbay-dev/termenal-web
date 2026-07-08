import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  analyzeRow,
  splitDirectionalRuns,
  directionForLevel,
  reorderRunsVisually,
  shapeLogicalRow,
  visualGlyphStream,
  loadFont,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Font-free core (always runs — the deterministic itemisation logic).
// ---------------------------------------------------------------------------

describe('directionForLevel', () => {
  it('maps level parity to direction', () => {
    expect(directionForLevel(0)).toBe('ltr');
    expect(directionForLevel(1)).toBe('rtl');
    expect(directionForLevel(2)).toBe('ltr');
    expect(directionForLevel(3)).toBe('rtl');
  });
});

describe('splitDirectionalRuns', () => {
  it('splits into maximal equal-level spans', () => {
    const spans = splitDirectionalRuns(Uint8Array.from([1, 1, 0, 0, 1]));
    expect(spans).toEqual([
      { start: 0, end: 2, level: 1 },
      { start: 2, end: 4, level: 0 },
      { start: 4, end: 5, level: 1 },
    ]);
  });
  it('returns no spans for empty input', () => {
    expect(splitDirectionalRuns(new Uint8Array(0))).toEqual([]);
  });
});

describe('analyzeRow', () => {
  it('pure Latin uses the LTR fast path (single ltr run, unchanged text)', () => {
    const row = analyzeRow('ls -la /home');
    expect(row.baseDirection).toBe('ltr');
    expect(row.runs).toHaveLength(1);
    expect(row.runs[0]).toMatchObject({ direction: 'ltr', level: 0, text: 'ls -la /home' });
    expect(row.levels).toHaveLength('ls -la /home'.length);
    expect([...row.levels].every((l) => l === 0)).toBe(true);
  });

  it('pure Arabic is a single RTL run with base rtl', () => {
    const text = 'مرحبا بالعالم';
    const row = analyzeRow(text);
    expect(row.baseDirection).toBe('rtl');
    expect(row.runs.every((r) => r.direction === 'rtl')).toBe(true);
    // Runs reconstruct the logical text exactly (logical buffer invariant, D-5).
    expect(row.runs.map((r) => r.text).join('')).toBe(text);
  });

  it('mixed Arabic + Latin yields both directional runs in logical order', () => {
    const text = 'افتح src ثم'; // "open src then"
    const row = analyzeRow(text);
    expect(row.baseDirection).toBe('rtl');
    expect(row.runs.length).toBeGreaterThanOrEqual(2);
    expect(row.runs.some((r) => r.direction === 'rtl')).toBe(true);
    expect(row.runs.some((r) => r.direction === 'ltr')).toBe(true);
    // The embedded Latin run carries "src" left-to-right in logical order.
    expect(row.runs.find((r) => r.direction === 'ltr')?.text).toContain('src');
    // Concatenated runs equal the untouched logical text.
    expect(row.runs.map((r) => r.text).join('')).toBe(text);
  });

  it('empty row has no runs', () => {
    const row = analyzeRow('');
    expect(row.runs).toEqual([]);
    expect(row.levels).toHaveLength(0);
  });

  it('respects an explicitly forced base direction', () => {
    const row = analyzeRow('123', 'rtl');
    expect(row.baseDirection).toBe('rtl');
  });
});

describe('reorderRunsVisually (UAX #9 L2 at run granularity)', () => {
  it('leaves all-LTR runs untouched', () => {
    const runs = [{ id: 'a', level: 0 }, { id: 'b', level: 0 }];
    expect(reorderRunsVisually(runs).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('reverses an RTL paragraph with an embedded LTR run', () => {
    // Logical: A(rtl) B(ltr) C(rtl) -> visual L->R: C B A
    const runs = [
      { id: 'A', level: 1 },
      { id: 'B', level: 2 },
      { id: 'C', level: 1 },
    ];
    expect(reorderRunsVisually(runs).map((r) => r.id)).toEqual(['C', 'B', 'A']);
  });

  it('reverses only the embedded RTL span inside an LTR paragraph', () => {
    // Logical: x(ltr) ع(rtl) ب(rtl) y(ltr) -> visual: x ب ع y
    const runs = [
      { id: 'x', level: 0 },
      { id: 'ain', level: 1 },
      { id: 'beh', level: 1 },
      { id: 'y', level: 0 },
    ];
    expect(reorderRunsVisually(runs).map((r) => r.id)).toEqual(['x', 'beh', 'ain', 'y']);
  });

  it('returns an empty array unchanged', () => {
    expect(reorderRunsVisually([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Font-backed pipeline (skipped when the Arabic font is unavailable).
// ---------------------------------------------------------------------------

const ARABIC_FONT = 'C:\\Windows\\Fonts\\trado.ttf';
const hasArabic = existsSync(ARABIC_FONT);

describe('shapeLogicalRow + visualGlyphStream', () => {
  it.skipIf(!hasArabic)('shapes a pure-Arabic row into joined glyph runs', () => {
    const font = loadFont(new Uint8Array(readFileSync(ARABIC_FONT)));
    const text = 'مرحبا بالعالم';
    const row = shapeLogicalRow(font, text);

    expect(row.text).toBe(text); // buffer stays logical
    expect(row.baseDirection).toBe('rtl');
    expect(row.runs.length).toBeGreaterThan(0);
    for (const run of row.runs) {
      expect(run.glyphs.length).toBeGreaterThan(0);
      expect(run.glyphs.every((g) => g.glyphId !== 0)).toBe(true); // full coverage
    }
    // Runs still reconstruct the logical text.
    expect(row.runs.map((r) => r.text).join('')).toBe(text);
  });

  it.skipIf(!hasArabic)('produces a visual glyph stream covering every run glyph', () => {
    const font = loadFont(new Uint8Array(readFileSync(ARABIC_FONT)));
    const row = shapeLogicalRow(font, 'مرحبا بالعالم');
    const stream = visualGlyphStream(row);
    const totalRunGlyphs = row.runs.reduce((n, r) => n + r.glyphs.length, 0);
    expect(stream.length).toBe(totalRunGlyphs);
    expect(stream.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasArabic)('accepts a font resolver (D-6 fallback hook)', () => {
    const font = loadFont(new Uint8Array(readFileSync(ARABIC_FONT)));
    const row = shapeLogicalRow((run) => {
      expect(run).toHaveProperty('direction');
      return font;
    }, 'سلام');
    expect(row.runs[0]?.glyphs.length).toBeGreaterThan(0);
  });
});
