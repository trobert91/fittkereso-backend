import { Test, TestingModule } from '@nestjs/testing';
import { identityWords, ProductNormalizerService } from './product-normalizer.service';

describe('ProductNormalizerService', () => {
  let service: ProductNormalizerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProductNormalizerService],
    }).compile();

    service = module.get<ProductNormalizerService>(ProductNormalizerService);
  });

  describe('identityWords', () => {
    it.each([
      ['letters and digits apart', 'CX830', ['cx', '830']],
      ['a plus on its word', 'E+', ['e+']],
      ['a lone plus joining the word before it', 'E +', ['e+']],
      ['a plus opening a word', 'Gravel +EQ', ['gravel', '+eq']],
      ['punctuation splitting words', 'C:62', ['c', '62']],
      ['accents and case dropped', 'Trapéz', ['trapez']],
      ['a word of punctuation alone dropped', 'Pro - 800 +', ['pro', '800+']],
    ])('reads %s', (_case, text, words) => {
      expect(identityWords(text)).toEqual(words);
    });
  });

  describe('normalizeModel', () => {
    const key = (text: string | undefined, brand = 'KTM', dropValues: string[] = []) =>
      service.normalizeModel({ text, brands: [brand], dropValues });

    it('keys "Macina Tour CX830" and "Macina Tour CX 830" alike', () => {
      expect(key('Macina Tour CX830')).toBe('830 cx macina tour');
      expect(key('Macina Tour CX 830')).toBe('830 cx macina tour');
    });

    it.each([
      ['spacing inside a model number', 'Macina Tour CX830', 'Macina Tour CX 830'],
      ['a number glued to a trim word', 'Stereo Hybrid ONE22 Pro 800', 'Stereo Hybrid ONE 22 Pro 800'],
      ['word order', 'Macina Cross 720', 'Cross Macina 720'],
      ['case and accents', 'Trapéz', 'TRAPEZ'],
      ['punctuation', 'Nuroad Hybrid C:62 Race 400X', 'Nuroad Hybrid C62 Race 400 X'],
      ['the brand anywhere', 'KTM Macina Style 810', 'Macina Style 810 KTM'],
    ])('agrees across %s', (_case, a, b) => {
      expect(key(a)).toBe(key(b));
    });

    it.each([
      ['Di2', 'Macina Style 810 Di2', 'Macina Style 810'],
      ['a trim swap', 'Stereo Hybrid ONE22 Pro 800', 'Stereo Hybrid ONE22 SLX 800'],
      ['FE', 'Nuroad Hybrid C:62 Race 400X FE', 'Nuroad Hybrid C:62 Race 400X'],
      ['a plus', 'Move+', 'Move'],
      ['the model number', 'Macina Style 810', 'Macina Style 820'],
    ])('tells apart %s', (_case, a, b) => {
      expect(key(a)).not.toBe(key(b));
    });

    it('sorts and de-duplicates the words', () => {
      expect(key('Macina Style 810 Style')).toBe('810 macina style');
    });

    it('keeps a plus on its word', () => {
      expect(key('Move+', 'Kalkhoff')).toBe('move+');
      expect(key('Explore E + 1', 'Giant')).toBe('1 e+ explore');
    });

    it('drops every word of a multi-word brand', () => {
      expect(key('Rock Machine Crossride e500', 'Rock Machine')).toBe('500 crossride e');
    });

    it('drops the words of every brand given', () => {
      expect(
        service.normalizeModel({ text: 'Liv Tempt E+ EX', brands: ['Giant', 'Liv'] }),
      ).toBe('e+ ex tempt');
    });

    it('drops a dropped value only where its words stand in a row', () => {
      // The year and the wheel size go; the 5 of 'E5' stays.
      expect(key('Macina E5 2026 27,5', 'KTM', ['2026', '27,5'])).toBe('5 e macina');
    });

    it('is undefined when nothing is left', () => {
      expect(key(undefined)).toBeUndefined();
      expect(key('KTM')).toBeUndefined();
      expect(key(' - ')).toBeUndefined();
    });
  });
});
