import { ProductImageStorageService } from './product-image-storage.service';
import type { FileStorageService } from '@fittkereso-backend/storage';
import type { HttpService } from '@nestjs/axios';

describe('ProductImageStorageService.uploadFromUrl', () => {
  let service: ProductImageStorageService;
  let storage: { uploadFile: jest.Mock };
  let http: { axiosRef: { get: jest.Mock } };

  beforeEach(() => {
    storage = { uploadFile: jest.fn().mockResolvedValue({ fileName: 'uploaded' }) };
    http = {
      axiosRef: {
        get: jest.fn().mockResolvedValue({ status: 200, data: Buffer.from('img') }),
      },
    };

    service = new ProductImageStorageService(
      storage as unknown as FileStorageService,
      http as unknown as HttpService,
    );
  });

  it('uses the extension from the URL pathname, ignoring the query string', async () => {
    await service.uploadFromUrl(
      'product-1',
      'https://cdn.example.com/image/1260044108.webp?lastmod=1761570968.1772457778',
    );

    const [, fileName] = storage.uploadFile.mock.calls[0];
    expect(fileName.endsWith('.webp')).toBe(true);
  });

  it('falls back to .jpg when the pathname has no extension', async () => {
    await service.uploadFromUrl('product-1', 'https://cdn.example.com/image?id=42');

    const [, fileName] = storage.uploadFile.mock.calls[0];
    expect(fileName.endsWith('.jpg')).toBe(true);
  });

  it('falls back to raw extname when the URL fails to parse', async () => {
    await service.uploadFromUrl('product-1', 'not-a-valid-url.png');

    const [, fileName] = storage.uploadFile.mock.calls[0];
    expect(fileName.endsWith('.png')).toBe(true);
  });
});
