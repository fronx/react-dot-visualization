import { describe, it, expect } from 'vitest';
import { restoreDecollisionedPositions } from '../DotVisualization.jsx';

const item = (id, x, y, color = 'red') => ({ id, x, y, color });

describe('restoreDecollisionedPositions', () => {
  const rawData = [item('a', 0, 0, 'red'), item('b', 1, 1, 'blue')];
  const decollided = [item('a', 0.5, 0.3, 'old'), item('b', 1.2, 1.1, 'old')];

  it('restores from cache when available', () => {
    const cache = new Map([['a', { x: 10, y: 20 }], ['b', { x: 30, y: 40 }]]);
    const result = restoreDecollisionedPositions(rawData, cache, []);
    expect(result[0]).toEqual({ id: 'a', x: 10, y: 20, color: 'red' });
    expect(result[1]).toEqual({ id: 'b', x: 30, y: 40, color: 'blue' });
  });

  it('falls back to previousProcessedData when cache is empty', () => {
    const result = restoreDecollisionedPositions(rawData, null, decollided);
    expect(result[0]).toEqual({ id: 'a', x: 0.5, y: 0.3, color: 'red' });
    expect(result[1]).toEqual({ id: 'b', x: 1.2, y: 1.1, color: 'blue' });
  });

  it('preserves non-position properties from validData, not previousProcessedData', () => {
    const result = restoreDecollisionedPositions(rawData, null, decollided);
    expect(result[0].color).toBe('red');
    expect(result[1].color).toBe('blue');
  });

  it('returns validData as-is when both cache and previousProcessedData are empty', () => {
    const result = restoreDecollisionedPositions(rawData, null, []);
    expect(result).toBe(rawData);
  });

  it('handles items missing from cache gracefully', () => {
    const cache = new Map([['a', { x: 10, y: 20 }]]);
    const result = restoreDecollisionedPositions(rawData, cache, []);
    expect(result[0]).toEqual({ id: 'a', x: 10, y: 20, color: 'red' });
    expect(result[1]).toEqual({ id: 'b', x: 1, y: 1, color: 'blue' });
  });

  it('handles items missing from previousProcessedData gracefully', () => {
    const partial = [item('a', 0.5, 0.3)];
    const result = restoreDecollisionedPositions(rawData, null, partial);
    expect(result[0].x).toBe(0.5);
    expect(result[1]).toEqual({ id: 'b', x: 1, y: 1, color: 'blue' });
  });

  it('prefers cache over previousProcessedData', () => {
    const cache = new Map([['a', { x: 99, y: 99 }], ['b', { x: 88, y: 88 }]]);
    const result = restoreDecollisionedPositions(rawData, cache, decollided);
    expect(result[0].x).toBe(99);
    expect(result[1].x).toBe(88);
  });

  it('treats empty Map as cache miss', () => {
    const result = restoreDecollisionedPositions(rawData, new Map(), decollided);
    expect(result[0].x).toBe(0.5);
  });

  describe('dot count changes (R9)', () => {
    it('preserves on-screen positions for existing dots when new dots are added', () => {
      const existing = [item('a', 0.5, 0.3), item('b', 1.2, 1.1)];
      const withNew = [item('a', 0, 0, 'red'), item('b', 1, 1, 'blue'), item('c', 5, 5)];
      const result = restoreDecollisionedPositions(withNew, null, existing);
      // Existing dots get their decollisioned positions
      expect(result[0]).toEqual({ id: 'a', x: 0.5, y: 0.3, color: 'red' });
      expect(result[1]).toEqual({ id: 'b', x: 1.2, y: 1.1, color: 'blue' });
      // New dot keeps its raw position (not found in processedDataRef)
      expect(result[2].id).toBe('c');
      expect(result[2].x).toBe(5);
      expect(result[2].y).toBe(5);
    });

    it('preserves on-screen positions for remaining dots when dots are removed', () => {
      const existing = [item('a', 0.5, 0.3), item('b', 1.2, 1.1), item('c', 3, 3)];
      const reduced = [item('a', 0, 0, 'red'), item('b', 1, 1, 'blue')];
      const result = restoreDecollisionedPositions(reduced, null, existing);
      expect(result[0]).toEqual({ id: 'a', x: 0.5, y: 0.3, color: 'red' });
      expect(result[1]).toEqual({ id: 'b', x: 1.2, y: 1.1, color: 'blue' });
    });
  });
});
