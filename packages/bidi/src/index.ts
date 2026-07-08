// @termenal-web/bidi
//
// Bidirectional ordering (Unicode UAX #9) plus a paragraph base-direction
// function ported verbatim from termenal-Ar
// (src/renderer/atlas/DWriteTextAnalysis.cpp: g_rtlRanges +
// GetParagraphReadingDirection). Implements directive D-2.
//
// Directionality is decided by a MAJORITY of strong characters, with a
// first-strong tiebreak and an LTR default — matching the fork exactly. Only
// ASCII A–Z/a–z count as strong LTR; digits and punctuation are weak/neutral.

import bidiFactory from 'bidi-js';
import type { EmbeddingLevels } from 'bidi-js';

export type Direction = 'ltr' | 'rtl';

/** Strong right-to-left Unicode ranges — verbatim from termenal-Ar g_rtlRanges. */
export const RTL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x000590, 0x0005ff], // Hebrew
  [0x000600, 0x0006ff], // Arabic
  [0x000700, 0x00074f], // Syriac
  [0x000750, 0x00077f], // Arabic Supplement
  [0x000780, 0x0007bf], // Thaana
  [0x0007c0, 0x0007ff], // N'Ko
  [0x000800, 0x00083f], // Samaritan
  [0x000840, 0x00085f], // Mandaic
  [0x000860, 0x00086f], // Syriac Supplement
  [0x0008a0, 0x0008ff], // Arabic Extended-A
  [0x00fb1d, 0x00fb4f], // Hebrew Presentation Forms
  [0x00fb50, 0x00fdff], // Arabic Presentation Forms-A
  [0x00fe70, 0x00feff], // Arabic Presentation Forms-B
  [0x010800, 0x010fff], // Cypriot, Aramaic, Phoenician, etc.
  [0x01e800, 0x01efff], // Mende Kikakui, Adlam, Arabic Math
];

/** True iff `cp` is a strong right-to-left codepoint. */
export function isStrongRtlChar(cp: number): boolean {
  for (const [lo, hi] of RTL_RANGES) {
    if (cp >= lo && cp <= hi) {
      return true;
    }
  }
  return false;
}

/** Fast pre-filter: does the string contain any strong-RTL codepoint at all? */
export function hasAnyStrongRtl(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x0590) {
      continue; // ASCII / Latin / control: never strong RTL
    }
    if (isStrongRtlChar(cp)) {
      return true;
    }
  }
  return false;
}

/**
 * Paragraph base reading direction, ported from termenal-Ar
 * GetParagraphReadingDirection: majority of strong chars, first-strong
 * tiebreak, LTR default.
 */
export function paragraphReadingDirection(text: string): Direction {
  let strongRtl = 0;
  let strongLtr = 0;
  let firstStrong: Direction | null = null;

  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
      strongLtr++;
      firstStrong ??= 'ltr';
      continue;
    }
    if (cp < 0x0590) {
      continue; // numbers, punctuation, whitespace: weak/neutral
    }
    if (isStrongRtlChar(cp)) {
      strongRtl++;
      firstStrong ??= 'rtl';
    }
  }

  if (strongRtl !== strongLtr) {
    return strongRtl > strongLtr ? 'rtl' : 'ltr';
  }
  return firstStrong === 'rtl' ? 'rtl' : 'ltr';
}

const bidi = bidiFactory();

/** Resolve UAX #9 embedding levels. Base direction defaults to first-strong. */
export function getEmbeddingLevels(text: string, base?: Direction): EmbeddingLevels {
  return bidi.getEmbeddingLevels(text, base);
}

/**
 * Reorder a logical string into visual order per UAX #9. Operates on UTF-16
 * code units (matching bidi-js); adequate for BMP terminal text.
 */
export function getVisualOrder(text: string, base?: Direction): string {
  const embeddingLevels = getEmbeddingLevels(text, base);
  const idx = Array.from({ length: text.length }, (_, i) => i);
  for (const [start, end] of bidi.getReorderSegments(text, embeddingLevels)) {
    let a = start;
    let b = end;
    while (a < b) {
      const tmp = idx[a]!;
      idx[a] = idx[b]!;
      idx[b] = tmp;
      a++;
      b--;
    }
  }
  return idx.map((i) => text[i]).join('');
}

export type { EmbeddingLevels } from 'bidi-js';
