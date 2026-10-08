import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ArkHttpTransport,
  ArkRequestError,
  publicIPv4,
  validateArkDownloadUrl,
} from '../src/main/generation/ark-transport';
import { ARK_ENDPOINT } from '../src/shared/generation/ark-types';

const signal = () => new AbortController().signal;
const mockedFetch = (
  handler: (
    url: string,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>,
) =>
  (async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init)) as typeof fetch;

test('adapter targets China endpoint once and parses exact image/video contracts', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const transport = new ArkHttpTransport(
    mockedFetch((url, init) => {
      calls.push({ url, init });
      return Response.json(
        url.endsWith('/images/generations')
          ? { data: [{ url: 'https://result.invalid/a.png' }] }
          : init?.method === 'POST'
            ? { id: 'cgt-test' }
            : {
                id: 'cgt-test',
                status: 'succeeded',
                content: { video_url: 'https://result.invalid/a.mp4' },
              },
      );
    }),
  );
  assert.deepEqual(
    await transport.createImage(
      { model: 'ep-fixture' },
      'test-token',
      signal(),
    ),
    { url: 'https://result.invalid/a.png' },
  );
  assert.deepEqual(
    await transport.createVideo(
      { model: 'ep-fixture' },
      'test-token',
      signal(),
    ),
    { id: 'cgt-test' },
  );
  assert.deepEqual(
    await transport.getVideo('cgt-test', 'test-token', signal()),
    { status: 'succeeded', url: 'https://result.invalid/a.mp4' },
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url, `${ARK_ENDPOINT}/images/generations`);
  assert.equal(calls[1]?.url, `${ARK_ENDPOINT}/contents/generations/tasks`);
  assert.equal(
    calls[2]?.url,
    `${ARK_ENDPOINT}/contents/generations/tasks/cgt-test`,
  );
  for (const call of calls) {
    assert.ok(call.init);
    assert.equal(call.init.redirect, 'error');
    assert.equal(
      (call.init.headers as Record<string, string>).Authorization,
      'Bearer test-token',
    );
  }
});

test('timeouts, 5xx and malformed successes are ambiguous; ordinary 4xx are rejected and never retried', async () => {
  for (const [status, body, ambiguous] of [
    [500, { error: { message: 'secret prompt should not surface' } }, true],
    [401, { error: { message: 'test-token' } }, false],
    [408, {}, true],
    [200, { id: {} }, true],
  ] as const) {
    let count = 0;
    const transport = new ArkHttpTransport(
      mockedFetch(() => {
        count++;
        return Response.json(body, { status });
      }),
    );
    await assert.rejects(
      transport.createVideo({}, 'test-token', signal()),
      (error: unknown) => {
        assert.ok(error instanceof ArkRequestError);
        assert.equal(error.submissionUnknown, ambiguous);
        assert.equal(error.message.includes('test-token'), false);
        assert.equal(error.message.includes('secret prompt'), false);
        return true;
      },
    );
    assert.equal(count, 1);
  }
  let calls = 0;
  const transport = new ArkHttpTransport(
    mockedFetch(() => {
      calls++;
      throw new Error('network contains secret');
    }),
  );
  await assert.rejects(
    transport.createImage({}, 'test-token', signal()),
    (error: unknown) =>
      error instanceof ArkRequestError &&
      error.submissionUnknown &&
      !error.message.includes('secret'),
  );
  assert.equal(calls, 1);
});

test('GET validates task identity/state; successful result requires a video URL', async () => {
  for (const body of [
    { id: 'other', status: 'running' },
    { id: 'task', status: 'bogus' },
    { id: 'task', status: 'succeeded', content: {} },
  ]) {
    const transport = new ArkHttpTransport(
      mockedFetch(() => Response.json(body)),
    );
    await assert.rejects(
      transport.getVideo('task', 'fixture', signal()),
      /无法验证|响应/,
    );
  }
  const transport = new ArkHttpTransport(
    mockedFetch(() => Response.json({ id: 'task', status: 'expired' })),
  );
  assert.deepEqual(await transport.getVideo('task', 'fixture', signal()), {
    status: 'expired',
  });
});

test('result downloads reject non-HTTPS, credentials, lookalike/private hosts and private DNS answers', () => {
  const host = 'ark-content-generation-cn-beijing.tos-cn-beijing.volces.com';
  assert.equal(
    validateArkDownloadUrl(`https://${host}/result?signature=private`).hostname,
    host,
  );
  for (const url of [
    `http://${host}/x`,
    `https://key@${host}/x`,
    `https://${host}:8443/x`,
    `https://${host}.evil.example/x`,
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'file:///etc/passwd',
    'https://other-bucket.tos-cn-beijing.volces.com/x',
  ])
    assert.throws(() => validateArkDownloadUrl(url));
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.31.1.1',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    '192.0.2.1',
  ])
    assert.equal(publicIPv4(ip), false, ip);
  assert.equal(publicIPv4('8.8.8.8'), true);
});
