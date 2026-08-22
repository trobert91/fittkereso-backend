import { FileStorageService } from './file-storage.service';
import type { BunnyStorageService } from '@fittkereso-backend/bunny';

describe('FileStorageService.uploadFile', () => {
  let service: FileStorageService;
  let bunnyStorageService: { uploadFile: jest.Mock };

  beforeEach(() => {
    bunnyStorageService = { uploadFile: jest.fn() };
    service = new FileStorageService(
      bunnyStorageService as unknown as BunnyStorageService,
    );
  });

  it('retries a Buffer upload after a transient failure and returns the eventual success', async () => {
    bunnyStorageService.uploadFile
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ fileName: 'uploaded.webp' });

    const result = await service.uploadFile(
      'products/1',
      'image.webp',
      Buffer.from('data'),
    );

    expect(result).toEqual({ fileName: 'uploaded.webp' });
    expect(bunnyStorageService.uploadFile).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries on a persistent failure', async () => {
    const error = new Error('persistent');
    bunnyStorageService.uploadFile.mockRejectedValue(error);

    await expect(
      service.uploadFile('products/1', 'image.webp', Buffer.from('data')),
    ).rejects.toThrow('persistent');
    expect(bunnyStorageService.uploadFile).toHaveBeenCalledTimes(3);
  });

  it('does not retry a ReadStream — only a single attempt is made', async () => {
    const error = new Error('stream failure');
    bunnyStorageService.uploadFile.mockRejectedValueOnce(error);
    const fakeStream = { pipe: jest.fn() } as any;

    await expect(
      service.uploadFile('products/1', 'image.webp', fakeStream),
    ).rejects.toThrow('stream failure');
    expect(bunnyStorageService.uploadFile).toHaveBeenCalledTimes(1);
  });

  it('does not retry a file path string — only a single attempt is made', async () => {
    bunnyStorageService.uploadFile.mockRejectedValueOnce(new Error('fail'));

    await expect(
      service.uploadFile('products/1', 'image.webp', '/tmp/local-file.jpg'),
    ).rejects.toThrow('fail');
    expect(bunnyStorageService.uploadFile).toHaveBeenCalledTimes(1);
  });
});
