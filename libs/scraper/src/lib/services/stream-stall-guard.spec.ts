import { PassThrough, Readable } from 'stream';
import { StreamStalledError, withStallGuard } from './stream-stall-guard';

const URL = 'https://shop.example/feed.xml';
const STALL_MS = 50;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const read = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
};

describe('withStallGuard', () => {
  it('passes the whole body through', async () => {
    const guarded = withStallGuard(Readable.from(['<products>', '<product/>', '</products>']), STALL_MS, URL);

    await expect(read(guarded)).resolves.toBe('<products><product/></products>');
  });

  it('fails a body that stops arriving while it is read, and closes the source', async () => {
    const source = new PassThrough();
    source.write('<products><product/>');
    const guarded = withStallGuard(source, STALL_MS, URL);

    await expect(read(guarded)).rejects.toThrow(StreamStalledError);
    expect(source.destroyed).toBe(true);
  });

  it('names the URL and the wait in the error', async () => {
    const guarded = withStallGuard(new PassThrough(), STALL_MS, URL);

    await expect(read(guarded)).rejects.toThrow(`Fetching ${URL} stalled: no data for 0 s while reading the body`);
  });

  // An import pauses between chunks for its own batches; the source has data
  // waiting all along, so that is no stall, however long the pause.
  it('does not count the time a slow reader takes', async () => {
    const source = new PassThrough();
    source.end('<products><product/></products>');
    const guarded = withStallGuard(source, STALL_MS, URL);

    const chunks: string[] = [];
    for await (const chunk of guarded) {
      chunks.push(String(chunk));
      await sleep(STALL_MS * 3);
    }
    expect(chunks.join('')).toBe('<products><product/></products>');
  });

  it('keeps reading a body that arrives slowly but steadily', async () => {
    const source = new PassThrough();
    const guarded = withStallGuard(source, STALL_MS, URL);
    const body = read(guarded);
    for (const part of ['<products>', '<product/>', '</products>']) {
      source.write(part);
      await sleep(STALL_MS / 2);
    }
    source.end();

    await expect(body).resolves.toBe('<products><product/></products>');
  });

  it('closes the source when its reader gives up', async () => {
    const source = new PassThrough();
    const guarded = withStallGuard(source, STALL_MS, URL);

    guarded.destroy();

    expect(source.destroyed).toBe(true);
  });

  it("passes the source's own error on", async () => {
    const source = new PassThrough();
    const guarded = withStallGuard(source, STALL_MS, URL);
    const body = read(guarded);
    source.destroy(new Error('socket hang up'));

    await expect(body).rejects.toThrow('socket hang up');
  });
});
