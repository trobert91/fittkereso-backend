import { retry } from './retry';

describe('retry', () => {
  it('returns the result on the first successful attempt', async () => {
    const operation = jest.fn().mockResolvedValue('ok');

    const result = await retry(operation, { delayMs: 0 });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure and returns the result once it succeeds', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');

    const result = await retry(operation, { delayMs: 0 });

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('gives up and throws the last error after exhausting all attempts', async () => {
    const error = new Error('persistent failure');
    const operation = jest.fn().mockRejectedValue(error);

    await expect(
      retry(operation, { attempts: 3, delayMs: 0 }),
    ).rejects.toThrow('persistent failure');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('defaults to 3 attempts when none is specified', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('fail'));

    await expect(retry(operation, { delayMs: 0 })).rejects.toThrow('fail');
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
