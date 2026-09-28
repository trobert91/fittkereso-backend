import { normalizeYear } from './year-utils';

describe('normalizeYear', () => {
  it.each([
    [2026, 2026],
    ['2026', 2026],
    [' 2026 ', 2026],
    // How Hungarian writes a year.
    ['2026.', 2026],
  ])('keeps the 4-digit year %p', (raw, expected) => {
    expect(normalizeYear(raw)).toBe(expected);
  });

  it.each([
    [26, 2026],
    [9, 2009],
    ['26', 2026],
    ["'26", 2026],
    ['’26', 2026],
    ['‘26', 2026],
    ['`26', 2026],
    ["'26.", 2026],
  ])('reads the two-digit year %p as 20xx', (raw, expected) => {
    expect(normalizeYear(raw)).toBe(expected);
  });

  it.each([
    ['2024-es', 2024],
    ['MY 2026', 2026],
    ['2026 modell', 2026],
    ['Modellév: 2025', 2025],
    // The same year twice is still one year.
    ['2026 / 2026', 2026],
  ])('finds the one year written inside %p', (raw, expected) => {
    expect(normalizeYear(raw)).toBe(expected);
  });

  it('reads a one-element array as its element', () => {
    expect(normalizeYear(['2026'])).toBe(2026);
    expect(normalizeYear(["'25"])).toBe(2025);
  });

  it.each([
    ['2025/2026'],
    ['2025-2026'],
    ['abc'],
    [''],
    ['   '],
    ['0026'],
    ['7'],
    ['MY26'],
    ['12026'],
    [2026.5],
    [150],
    [-26],
    [1899],
    [2100],
    [true],
    [null],
    [undefined],
    [[]],
    [['2025', '2026']],
    [{ year: 2026 }],
  ])('gives nothing for %p, which is not one year', (raw) => {
    expect(normalizeYear(raw)).toBeUndefined();
  });
});
