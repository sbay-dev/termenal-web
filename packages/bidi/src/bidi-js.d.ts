// Minimal ambient typing for the subset of `bidi-js` used here.
// bidi-js ships JS without bundled .d.ts; we type only what we consume.
declare module 'bidi-js' {
  export interface Paragraph {
    start: number;
    end: number;
    level: number;
  }
  export interface EmbeddingLevels {
    levels: Uint8Array;
    paragraphs: Paragraph[];
  }
  export interface Bidi {
    getEmbeddingLevels(text: string, explicitDirection?: 'ltr' | 'rtl'): EmbeddingLevels;
    getReorderSegments(
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): [number, number][];
    getReorderedIndices(
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): number[];
    getMirroredCharacter(char: string): string | null;
  }
  export default function bidiFactory(): Bidi;
}
