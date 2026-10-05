import { findDescriptionEvidence } from './description-evidence';

describe('findDescriptionEvidence', () => {
  const find = (text: string, keywords: string[], windowWords = 2, maxChars?: number) =>
    findDescriptionEvidence(text, keywords, { windowWords, maxChars });

  it('keeps the words around a keyword, as the text writes them', () => {
    expect(find('A KTM Macina Style elektromos Trekking kerékpár, 51cm-es vázzal.', ['trekking'])).toEqual([
      'Style elektromos Trekking kerékpár, 51cm-es',
    ]);
  });

  it('finds nothing in a text without a keyword', () => {
    expect(find('Könnyű, strapabíró váz.', ['trekking', 'gravel'])).toEqual([]);
    expect(find('', ['trekking'])).toEqual([]);
  });

  // A keyword is written as people write it; a shop may leave the accents off.
  it('ignores accents and case, on either side', () => {
    expect(find('egy TURA bringa', ['túra'])).toEqual(['egy TURA bringa']);
    expect(find('egy túra bringa', ['TURA'])).toEqual(['egy túra bringa']);
  });

  // Hungarian glues suffixes and other words onto a word.
  it('takes a word that starts with a keyword: suffixes and compounds', () => {
    expect(find('kényelmes túrabringa a KTM-től', ['túra'], 1)).toEqual(['kényelmes túrabringa a']);
    expect(find('a gyerekkerékpárok között', ['gyerek'], 1)).toEqual(['a gyerekkerékpárok között']);
  });

  it('takes one typo in a long keyword, alone or before a suffix', () => {
    expect(find('egy treking kerékpár', ['trekking'], 1)).toEqual(['egy treking kerékpár']);
    expect(find('egy trekingkerékpár itt', ['trekking'], 1)).toEqual(['egy trekingkerékpár itt']);
  });

  // "city" one edit from "cite" would take far too much.
  it('takes no typo in a short keyword', () => {
    expect(find('they cite the city', ['cyti'])).toEqual([]);
  });

  it('matches a keyword of several words in a row, and a word with a hyphen in it', () => {
    expect(find('egy igazi mountain bike ez', ['mountain bike'], 1)).toEqual(['igazi mountain bike']);
    expect(find('a mountain range bike', ['mountain bike'])).toEqual([]);
    expect(find('a sportos e-MTB mód', ['mtb'], 1)).toEqual(['sportos e-MTB mód']);
  });

  it('makes one excerpt of overlapping windows, and keeps apart ones apart', () => {
    const text = 'one two trekking three gravel four five six seven eight gravel nine';
    expect(find(text, ['trekking', 'gravel'])).toEqual([
      'one two trekking three gravel four five',
      'seven eight gravel nine',
    ]);
  });

  // A long description sends what fits, in the text's order, cutting the
  // excerpt that reaches the cap rather than dropping it.
  it('stops at the character cap', () => {
    const text = 'aaa trekking bbb ccc ddd eee fff ggg gravel hhh';
    expect(find(text, ['trekking', 'gravel'], 1, 20)).toEqual(['aaa trekking bbb']);
    expect(find(text, ['trekking', 'gravel'], 2, 14)).toEqual(['aaa trekking']);
  });
});
