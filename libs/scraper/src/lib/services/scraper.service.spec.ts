import { Readable } from 'stream';
import {
  PROXIED_MAX_BYTES,
  ProxiedResponseTruncatedError,
  ScraperService,
} from './scraper.service';

const URL = 'https://shop.example/termek/1';

const read = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
};

describe('ScraperService', () => {
  let zyte: { scrape: jest.Mock };
  let native: { fetch: jest.Mock; stream: jest.Mock };
  let service: ScraperService;

  beforeEach(() => {
    zyte = { scrape: jest.fn().mockResolvedValue('<html>zyte</html>') };
    native = {
      fetch: jest.fn().mockResolvedValue({ statusCode: 200, body: '<html>direct</html>' }),
      stream: jest.fn().mockResolvedValue({
        statusCode: 200,
        contentType: 'text/xml',
        stream: Readable.from(['<products/>']),
      }),
    };
    service = new ScraperService(zyte as never, native as never);
  });

  describe('getHtml', () => {
    it('goes through Zyte when proxied', async () => {
      await expect(service.getHtml(URL, 'proxied')).resolves.toBe('<html>zyte</html>');
      expect(zyte.scrape).toHaveBeenCalledWith(URL);
      expect(native.fetch).not.toHaveBeenCalled();
    });

    it('calls the shop itself when direct', async () => {
      await expect(service.getHtml(URL, 'direct')).resolves.toBe('<html>direct</html>');
      expect(native.fetch).toHaveBeenCalledWith(URL);
      expect(zyte.scrape).not.toHaveBeenCalled();
    });
  });

  describe('stream', () => {
    it('streams from the shop, with its content type, when direct', async () => {
      const { stream, contentType } = await service.stream(URL, 'direct');

      expect(contentType).toBe('text/xml');
      await expect(read(stream)).resolves.toBe('<products/>');
      expect(zyte.scrape).not.toHaveBeenCalled();
    });

    it('wraps the Zyte body, with no content type, when proxied', async () => {
      const { stream, contentType } = await service.stream(URL, 'proxied');

      expect(contentType).toBeUndefined();
      await expect(read(stream)).resolves.toBe('<html>zyte</html>');
      expect(native.stream).not.toHaveBeenCalled();
    });
  });

  // Zyte cuts a longer body at its limit and reports success.
  describe('the truncation guard', () => {
    it('refuses a proxied body at the limit, for pages and feeds alike', async () => {
      zyte.scrape.mockResolvedValue('x'.repeat(PROXIED_MAX_BYTES));

      await expect(service.getHtml(URL, 'proxied')).rejects.toBeInstanceOf(
        ProxiedResponseTruncatedError,
      );
      await expect(service.stream(URL, 'proxied')).rejects.toThrow(/10 MB limit/);
    });

    it('counts bytes, not characters', async () => {
      // 'ő' is two bytes in UTF-8.
      zyte.scrape.mockResolvedValue('ő'.repeat(PROXIED_MAX_BYTES / 2));

      await expect(service.getHtml(URL, 'proxied')).rejects.toBeInstanceOf(
        ProxiedResponseTruncatedError,
      );
    });

    it('passes a body just below it', async () => {
      const body = 'x'.repeat(PROXIED_MAX_BYTES - 1);
      zyte.scrape.mockResolvedValue(body);

      await expect(service.getHtml(URL, 'proxied')).resolves.toBe(body);
    });

    it('does not apply to a direct fetch', async () => {
      const body = 'x'.repeat(PROXIED_MAX_BYTES + 1);
      native.fetch.mockResolvedValue({ statusCode: 200, body });

      await expect(service.getHtml(URL, 'direct')).resolves.toBe(body);
    });
  });
});
