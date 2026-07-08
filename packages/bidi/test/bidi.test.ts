import { describe, it, expect } from 'vitest';
import {
  isStrongRtlChar,
  hasAnyStrongRtl,
  paragraphReadingDirection,
  getVisualOrder,
} from '../src/index.js';

describe('isStrongRtlChar', () => {
  it('detects Hebrew and Arabic ranges', () => {
    expect(isStrongRtlChar(0x0590)).toBe(true); // Hebrew start
    expect(isStrongRtlChar(0x05ff)).toBe(true); // Hebrew end
    expect(isStrongRtlChar(0x0627)).toBe(true); // Arabic alef
    expect(isStrongRtlChar(0xfe70)).toBe(true); // Arabic Presentation Forms-B
  });
  it('rejects Latin, digits and below-0x0590', () => {
    expect(isStrongRtlChar(0x41)).toBe(false); // 'A'
    expect(isStrongRtlChar(0x30)).toBe(false); // '0'
    expect(isStrongRtlChar(0x058f)).toBe(false); // just below Hebrew
  });
});

describe('hasAnyStrongRtl', () => {
  it('is false for pure ASCII and true when Arabic is present', () => {
    expect(hasAnyStrongRtl('ls -la /home')).toBe(false);
    expect(hasAnyStrongRtl('open ملف')).toBe(true);
  });
});

describe('paragraphReadingDirection (parity with fork)', () => {
  it('pure Arabic => rtl', () => {
    expect(paragraphReadingDirection('مرحبا بالعالم من الطرفية')).toBe('rtl');
  });
  it('pure Latin command => ltr', () => {
    expect(paragraphReadingDirection('ls -la /home/user')).toBe('ltr');
  });
  it('digits are weak (not strong LTR)', () => {
    // Only strong chars count; "42 مسار" has strong RTL > strong LTR(0) => rtl.
    expect(paragraphReadingDirection('42 مسار')).toBe('rtl');
  });
  it('majority strong wins over first-strong', () => {
    // First strong is LTR ('a'), but Arabic strong majority => rtl.
    expect(paragraphReadingDirection('a مرحبا بالعالم')).toBe('rtl');
  });
  it('equal strong counts fall back to first-strong', () => {
    // 1 strong LTR, 1 strong RTL, first strong is RTL => rtl.
    expect(paragraphReadingDirection('ا b')).toBe('rtl');
    // first strong is LTR => ltr.
    expect(paragraphReadingDirection('b ا')).toBe('ltr');
  });
});

describe('getVisualOrder', () => {
  it('reverses a pure-RTL run', () => {
    const logical = 'ابج'; // alef, beh, jeem (3 code units)
    expect(getVisualOrder(logical)).toBe('جبا');
  });
  it('leaves pure-LTR text unchanged', () => {
    expect(getVisualOrder('abc 123')).toBe('abc 123');
  });
});
