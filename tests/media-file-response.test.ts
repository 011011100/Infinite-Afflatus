import assert from 'node:assert/strict';
import { mkdtemp, open, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mediaFileResponse } from '../src/main/media/file-response';

test('local media responses support complete, partial, suffix and HEAD reads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'afflatus-media-response-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.mp4');
  const bytes = Buffer.from('0123456789');
  await writeFile(file, bytes);
  const request = (range?: string, method = 'GET') =>
    new Request('https://media.test/video', {
      method,
      headers: range ? { Range: range } : {},
    });
  const complete = await mediaFileResponse(file, request());
  assert.equal(complete.status, 200);
  assert.equal(complete.headers.get('accept-ranges'), 'bytes');
  assert.equal(complete.headers.get('content-type'), 'video/mp4');
  assert.equal(complete.headers.get('content-length'), '10');
  assert.equal(complete.headers.get('content-range'), null);
  assert.equal(await complete.text(), '0123456789');

  for (const [range, expected, contentRange] of [
    ['bytes=0-', '0123456789', 'bytes 0-9/10'],
    ['bytes=3-', '3456789', 'bytes 3-9/10'],
    ['bytes=3-5', '345', 'bytes 3-5/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=8-100', '89', 'bytes 8-9/10'],
    ['bytes=-100', '0123456789', 'bytes 0-9/10'],
  ] as const) {
    const response = await mediaFileResponse(file, request(range));
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(
      response.headers.get('content-length'),
      String(expected.length),
    );
    assert.equal(await response.text(), expected);
  }
  const head = await mediaFileResponse(file, request('bytes=3-', 'HEAD'));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(head.body, null);
});

test('invalid or unsatisfiable ranges do not return an unrelated video body', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'afflatus-media-response-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.webm');
  await writeFile(file, '0123456789');
  for (const range of [
    'bytes=10-',
    'bytes=6-4',
    'bytes=-0',
    'bytes=-',
    'bytes=0-1,3-4',
    'bytes=9007199254740992-',
    'invalid',
  ]) {
    const response = await mediaFileResponse(
      file,
      new Request('https://media.test/video', { headers: { Range: range } }),
    );
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
    assert.equal(response.body, null);
  }
  await writeFile(file, '');
  const empty = await mediaFileResponse(
    file,
    new Request('https://media.test/video'),
  );
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('content-length'), '0');
  assert.equal(empty.body, null);
});

test('a cancelled media response releases its stream and supports the next seek', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'afflatus-media-response-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.mp4');
  await writeFile(file, Buffer.alloc(1024 * 1024, 7));
  const response = await mediaFileResponse(
    file,
    new Request('https://media.test/video'),
  );
  await response.body?.cancel();
  const next = await mediaFileResponse(
    file,
    new Request('https://media.test/video', {
      headers: { Range: 'bytes=900000-900009' },
    }),
  );
  assert.equal(next.status, 206);
  assert.deepEqual(Buffer.from(await next.arrayBuffer()), Buffer.alloc(10, 7));
});

test('media read leases release exactly once for HEAD, invalid ranges, missing files and aborted requests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'afflatus-media-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.mp4');
  await writeFile(file, 'preview');
  for (const request of [
    new Request('https://media.test/preview', { method: 'HEAD' }),
    new Request('https://media.test/preview', {
      headers: { Range: 'bytes=99-' },
    }),
  ]) {
    let released = 0;
    const response = await mediaFileResponse(file, request, () => {
      released++;
    });
    assert.equal(response.body, null);
    assert.equal(released, 1);
  }
  let released = 0;
  await assert.rejects(
    mediaFileResponse(
      join(root, 'missing'),
      new Request('https://media.test/preview'),
      () => {
        released++;
      },
    ),
  );
  assert.equal(released, 1);
  const controller = new AbortController();
  controller.abort();
  released = 0;
  await assert.rejects(
    mediaFileResponse(
      file,
      new Request('https://media.test/preview', { signal: controller.signal }),
      () => {
        released++;
      },
    ),
  );
  assert.equal(released, 1);
});

test('authorized descriptors are never reopened and close for HEAD, ranges, cancellation and errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'afflatus-open-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'stage.ready');
  await writeFile(file, '0123456789');
  const handle = await open(file, 'r');
  // A consumer receives the whole file even if authorization inspected its bytes.
  await handle.read(Buffer.alloc(3), 0, 3, null);
  await unlink(file);
  await writeFile(file, 'replacement');
  const complete = await mediaFileResponse(
    { handle, filename: 'reference.mp4' },
    new Request('https://media.test/open'),
  );
  assert.equal(complete.headers.get('content-type'), 'video/mp4');
  assert.equal(await complete.text(), '0123456789');
  assert.equal(handle.fd, -1);

  for (const request of [
    new Request('https://media.test/open', { method: 'HEAD' }),
    new Request('https://media.test/open', { headers: { Range: 'bytes=99-' } }),
  ]) {
    const current = await open(file, 'r');
    const response = await mediaFileResponse(
      { handle: current, filename: 'reference.png' },
      request,
    );
    assert.equal(response.body, null);
    assert.equal(current.fd, -1);
  }
  const controller = new AbortController();
  controller.abort();
  const aborted = await open(file, 'r');
  await assert.rejects(
    mediaFileResponse(
      { handle: aborted, filename: 'reference.wav' },
      new Request('https://media.test/open', { signal: controller.signal }),
    ),
  );
  assert.equal(aborted.fd, -1);
  const cancelled = await open(file, 'r');
  let closed = () => {};
  const closure = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const response = await mediaFileResponse(
    { handle: cancelled, filename: 'reference.wav' },
    new Request('https://media.test/open'),
    closed,
  );
  await response.body?.cancel();
  // Cancellation destroys the stream; its close event owns descriptor release.
  await closure;
  assert.equal(cancelled.fd, -1);
});
