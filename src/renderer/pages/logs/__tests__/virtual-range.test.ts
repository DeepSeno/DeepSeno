import { describe, expect, it } from 'vitest';
import { getVirtualRange } from '../virtual-range';

describe('getVirtualRange', () => {
  it('returns an empty range for empty lists', () => {
    expect(getVirtualRange(0, 0, 500, 32)).toEqual({
      start: 0,
      end: 0,
      offsetTop: 0,
      totalHeight: 0,
    });
  });

  it('includes overscan around visible rows', () => {
    expect(getVirtualRange(1000, 320, 160, 32, 2)).toEqual({
      start: 8,
      end: 17,
      offsetTop: 256,
      totalHeight: 32000,
    });
  });

  it('clamps the range at list boundaries', () => {
    expect(getVirtualRange(10, 10_000, 200, 32, 5)).toEqual({
      start: 10,
      end: 10,
      offsetTop: 320,
      totalHeight: 320,
    });
  });
});
