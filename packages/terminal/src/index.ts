// @termenal-web/terminal
//
// The logical-row pipeline: the web analog of the fork's DirectWrite path.
// Takes a row of terminal text in LOGICAL order (the buffer never changes),
// splits it into bidi directional runs, and shapes each run with HarfBuzz so
// Arabic joins correctly. Implements directives D-2 (bidi) + D-1 (shaping)
// composed, and honours D-5 (logical buffer, renderer owns visual).
//
// Scope: this is the "match the fork standard" core — contextual joining +
// first-strong base direction + per-run visual glyph order. Full visual
// cell-grid reordering with cursor mirroring (microsoft/terminal#538) is a
// renderer concern and remains out of v1 scope; `reorderRunsVisually` /
// `visualGlyphStream` are provided as the building blocks a renderer composes.

import {
  paragraphReadingDirection,
  hasAnyStrongRtl,
  getEmbeddingLevels,
  type Direction,
} from '@termenal-web/bidi';
import { shapeRun, type LoadedFont, type ShapedGlyph } from '@termenal-web/shaping';

/** A maximal span of equal bidi embedding level (no direction/text resolved). */
export interface DirectionalSpan {
  /** Inclusive UTF-16 start offset in the row text. */
  start: number;
  /** Exclusive UTF-16 end offset in the row text. */
  end: number;
  /** UAX #9 embedding level of every code unit in the span. */
  level: number;
}

/** A directional run: a {@link DirectionalSpan} with its direction and text. */
export interface RunSpan extends DirectionalSpan {
  /** Run direction, derived from level parity (odd = rtl). */
  direction: Direction;
  /** The run's substring in LOGICAL order (`text.slice(start, end)`). */
  text: string;
}

/** Result of analysing a row without shaping (font-free, CI-safe). */
export interface RowAnalysis {
  /** The original logical row text, unchanged. */
  text: string;
  /** Paragraph base direction (first-strong / majority-strong, parity w/ fork). */
  baseDirection: Direction;
  /** Per-code-unit UAX #9 embedding levels. */
  levels: Uint8Array;
  /** Directional runs in LOGICAL order. */
  runs: RunSpan[];
}

/** A shaped run: a {@link RunSpan} plus its joined, positioned glyphs. */
export interface ShapedRun extends RunSpan {
  /** Joined glyphs for the run (HarfBuzz emits them in the run's visual order). */
  glyphs: ShapedGlyph[];
}

/** A fully shaped row: logical text + base direction + shaped runs. */
export interface ShapedRow {
  /** The original logical row text, unchanged (the buffer stays logical). */
  text: string;
  /** Paragraph base direction. */
  baseDirection: Direction;
  /** Per-code-unit UAX #9 embedding levels. */
  levels: Uint8Array;
  /** Shaped directional runs in LOGICAL order. */
  runs: ShapedRun[];
}

/** Resolves which loaded font to shape a given run with (enables D-6 fallback). */
export type FontResolver = (run: RunSpan) => LoadedFont;

/** Options for {@link shapeLogicalRow}. */
export interface ShapeRowOptions {
  /** Force the paragraph base direction instead of auto-detecting it. */
  base?: Direction;
  /** BCP-47 language tag passed through to the shaper. */
  language?: string;
}

/** Direction implied by a bidi embedding level (odd = RTL). */
export function directionForLevel(level: number): Direction {
  return level % 2 === 1 ? 'rtl' : 'ltr';
}

/**
 * Split per-code-unit embedding levels into maximal equal-level spans. Pure and
 * font-free — the deterministic core of run itemisation.
 */
export function splitDirectionalRuns(levels: Uint8Array): DirectionalSpan[] {
  const spans: DirectionalSpan[] = [];
  const n = levels.length;
  let start = 0;
  while (start < n) {
    const level = levels[start]!;
    let end = start + 1;
    while (end < n && levels[end] === level) {
      end += 1;
    }
    spans.push({ start, end, level });
    start = end;
  }
  return spans;
}

/**
 * Analyse a logical row into base direction, embedding levels and directional
 * runs — without shaping. Font-free, so this is the fully unit-testable core.
 *
 * Fast path (mirrors the fork's `w < 0x0590` early-out and D-3): a row with no
 * strong-RTL code point and an LTR base skips bidi entirely and yields a single
 * LTR run.
 */
export function analyzeRow(text: string, base?: Direction): RowAnalysis {
  const baseDirection = base ?? paragraphReadingDirection(text);

  if (baseDirection === 'ltr' && !hasAnyStrongRtl(text)) {
    const levels = new Uint8Array(text.length);
    const runs: RunSpan[] =
      text.length === 0
        ? []
        : [{ start: 0, end: text.length, level: 0, direction: 'ltr', text }];
    return { text, baseDirection, levels, runs };
  }

  const embedding = getEmbeddingLevels(text, baseDirection);
  const runs: RunSpan[] = splitDirectionalRuns(embedding.levels).map((span) => ({
    ...span,
    direction: directionForLevel(span.level),
    text: text.slice(span.start, span.end),
  }));
  return { text, baseDirection, levels: embedding.levels, runs };
}

/**
 * Reorder runs from logical into visual order per UAX #9 rule L2, applied at run
 * granularity (each run already has a uniform level, and its glyphs are in the
 * run's own visual order). Pure and font-free.
 */
export function reorderRunsVisually<T extends { level: number }>(runs: readonly T[]): T[] {
  const order = runs.slice();
  if (order.length === 0) {
    return order;
  }

  let maxLevel = 0;
  let minOddLevel = Number.POSITIVE_INFINITY;
  for (const run of order) {
    if (run.level > maxLevel) {
      maxLevel = run.level;
    }
    if (run.level % 2 === 1 && run.level < minOddLevel) {
      minOddLevel = run.level;
    }
  }
  if (!Number.isFinite(minOddLevel)) {
    return order; // all even levels: visual order == logical order
  }

  for (let level = maxLevel; level >= minOddLevel; level -= 1) {
    let i = 0;
    while (i < order.length) {
      if (order[i]!.level >= level) {
        let j = i;
        while (j + 1 < order.length && order[j + 1]!.level >= level) {
          j += 1;
        }
        let a = i;
        let b = j;
        while (a < b) {
          const tmp = order[a]!;
          order[a] = order[b]!;
          order[b] = tmp;
          a += 1;
          b -= 1;
        }
        i = j + 1;
      } else {
        i += 1;
      }
    }
  }
  return order;
}

/**
 * Shape a logical row into joined glyph runs. Composes {@link analyzeRow} with
 * per-run HarfBuzz shaping; each run's direction is set explicitly and its
 * script is guessed from the run text.
 *
 * @param font A single loaded font, or a resolver (for Arabic/mono fallback).
 */
export function shapeLogicalRow(
  font: LoadedFont | FontResolver,
  text: string,
  options: ShapeRowOptions = {},
): ShapedRow {
  const resolve: FontResolver = typeof font === 'function' ? font : () => font;
  const analysis = analyzeRow(text, options.base);
  const runs: ShapedRun[] = analysis.runs.map((run) => ({
    ...run,
    glyphs: shapeRun(resolve(run), run.text, {
      direction: run.direction,
      language: options.language,
    }),
  }));
  return {
    text: analysis.text,
    baseDirection: analysis.baseDirection,
    levels: analysis.levels,
    runs,
  };
}

/**
 * Flatten a shaped row into a single left-to-right visual glyph stream — the
 * exact sequence a renderer draws. Runs are placed in visual order; glyphs
 * within each run are already visually ordered by HarfBuzz.
 */
export function visualGlyphStream(row: ShapedRow): ShapedGlyph[] {
  const stream: ShapedGlyph[] = [];
  for (const run of reorderRunsVisually(row.runs)) {
    for (const glyph of run.glyphs) {
      stream.push(glyph);
    }
  }
  return stream;
}

export { loadFont } from '@termenal-web/shaping';
export type { LoadedFont, ShapedGlyph } from '@termenal-web/shaping';
export type { Direction } from '@termenal-web/bidi';
