import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { imageInfo, wavDuration } from '../src/main/generation/ark-media';
import { arkImageSize } from '../src/main/generation/ark-snapshot';
import { arkFixture, mockTransport, png } from './ark-generation-fixture';

function wav(seconds: number) {
  const bytes = Buffer.alloc(44 + Math.floor(seconds * 8000));
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(8000, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
async function add(
  f: Awaited<ReturnType<typeof arkFixture>>,
  kind: 'image' | 'text' | 'video' | 'audio',
  bytes: Buffer,
  suffix = '',
) {
  return f.library.acceptResult(
    {
      projectId: f.project.id,
      resultKey: `reference:ark-fixture-${kind}${suffix}`,
      name: `参考-${kind}`,
      kind,
      usage: 'reference',
      extension: { image: 'png', text: 'txt', video: 'mp4', audio: 'wav' }[
        kind
      ],
    },
    Readable.from(bytes),
  );
}
test('staged reference snapshots preserve group order and text override without changing source', async (t) => {
  let body: Record<string, unknown> | undefined;
  const f = await arkFixture(
    'image',
    mockTransport({
      createImage: async (request) => {
        body = request;
        return { url: 'https://fixture.invalid/image' };
      },
    }),
  );
  t.after(() => f.dispose());
  const pause = f.library.saves.pauseLocalReferences();
  t.after(() => pause.resume());
  await pause.idle();
  const text = await add(f, 'text', Buffer.from('源文件不应发送'));
  const image = await add(f, 'image', png());
  const ws = await f.library.generation.readWorkspace(f.project.id);
  const shot = ws.shots[0];
  assert.ok(shot);
  shot.nodes.push(
    {
      id: 'overridden',
      type: 'asset',
      assetId: text.id,
      textOverride: '覆盖后的文本',
      groupId: f.target.groupId,
      position: { x: 10, y: 300 },
    },
    {
      id: 'image',
      type: 'asset',
      assetId: image.id,
      groupId: f.target.groupId,
      position: { x: 300, y: 10 },
    },
    {
      id: 'last',
      type: 'text',
      text: '最后一段',
      groupId: f.target.groupId,
      position: { x: 10, y: 500 },
    },
  );
  await f.library.generation.saveWorkspace(f.project.id, ws);
  const preview = await f.service.preview('window', f.target);
  assert.equal(preview.prompt, '测试提示词\n\n覆盖后的文本\n\n最后一段');
  assert.deepEqual(
    preview.references.map((item) => item.nodeId),
    ['overridden', 'image'],
  );
  assert.equal(JSON.stringify(preview).includes('data:image'), false);
  assert.equal(f.library.store.job(image.id).status, 'ready');
  await f.service.submit('window', preview.token);
  await f.service.idle();
  assert.equal(body?.prompt, preview.prompt);
  assert.ok(Array.isArray(body?.image));
  assert.match(String(body?.image?.[0]), /^data:image\/png;base64,/);
  assert.equal(
    await f.library.generation.readText(f.project.id, text.id),
    '源文件不应发送',
  );
});

test('reference byte edits after preview prevent transmission even if size is unchanged', async (t) => {
  let posts = 0;
  const f = await arkFixture(
    'image',
    mockTransport({
      createImage: async () => {
        posts++;
        return { url: 'https://fixture.invalid/image' };
      },
    }),
  );
  t.after(() => f.dispose());
  const image = await add(f, 'image', png());
  await f.library.saves.idle();
  const ws = await f.library.generation.readWorkspace(f.project.id);
  const shot = ws.shots[0];
  assert.ok(shot);
  shot.nodes.push({
    id: 'ref',
    type: 'asset',
    assetId: image.id,
    groupId: f.target.groupId,
    position: { x: 0, y: 0 },
  });
  await f.library.generation.saveWorkspace(f.project.id, ws);
  const preview = await f.service.preview(1, f.target);
  const asset = (await f.library.projects.open(f.project.id)).assets.find(
    (item) => item.id === image.id,
  );
  assert.ok(asset);
  await writeFile(
    join(f.library.store.root, f.project.folder, asset.relativePath),
    png(600, 500),
  );
  await assert.rejects(f.service.submit(1, preview.token), /变化|检查/);
  assert.equal(posts, 0);
});

test('Seedance uses explicit reference_image roles and enforces reference limits', async (t) => {
  let body: Record<string, unknown> | undefined;
  const f = await arkFixture(
    'video',
    mockTransport({
      createVideo: async (request) => {
        body = request;
        return { id: 'cgt-reference' };
      },
    }),
  );
  t.after(() => f.dispose());
  const image = await add(f, 'image', png());
  await f.library.saves.idle();
  let ws = await f.library.generation.readWorkspace(f.project.id);
  const shot = ws.shots[0];
  assert.ok(shot);
  shot.nodes.push({
    id: 'ref',
    type: 'asset',
    assetId: image.id,
    groupId: f.target.groupId,
    position: { x: 0, y: 0 },
  });
  await f.library.generation.saveWorkspace(f.project.id, ws);
  const preview = await f.service.preview(1, f.target);
  assert.equal(preview.references[0]?.role, 'reference_image');
  await f.service.submit(1, preview.token);
  await f.service.idle();
  assert.ok(body);
  assert.deepEqual(
    (body.content as Array<{ role?: string }>).map((item) => item.role),
    [undefined, 'reference_image'],
  );
  // A separate group exercises preflight limits without bypassing active-job lock.
  ws = await f.library.generation.readWorkspace(f.project.id);
  const current = ws.shots[0];
  const group = current?.groups[0];
  assert.ok(current && group);
  current.groups.push({ ...group, id: 'too-many' });
  for (let i = 0; i < 10; i++)
    current.nodes.push({
      id: `extra-${i}`,
      type: 'asset',
      assetId: image.id,
      groupId: 'too-many',
      position: { x: i * 10, y: 0 },
    });
  current.nodes.push({
    id: 'extra-text',
    type: 'text',
    text: '数量限制',
    groupId: 'too-many',
    position: { x: 0, y: 0 },
  });
  await f.library.generation.saveWorkspace(f.project.id, ws);
  await assert.rejects(
    f.service.preview(1, { ...f.target, groupId: 'too-many' }),
    /数量/,
  );
});

test('unsupported local videos fail before POST and audio duration must be verifiable', async (t) => {
  let posts = 0;
  const f = await arkFixture(
    'video',
    mockTransport({
      createVideo: async () => {
        posts++;
        return { id: 'cgt-no' };
      },
    }),
  );
  t.after(() => f.dispose());
  const video = await add(f, 'video', Buffer.from('video'));
  await f.library.saves.idle();
  const ws = await f.library.generation.readWorkspace(f.project.id);
  const shot = ws.shots[0];
  assert.ok(shot);
  shot.nodes.push({
    id: 'video-ref',
    type: 'asset',
    assetId: video.id,
    groupId: f.target.groupId,
    position: { x: 0, y: 0 },
  });
  await f.library.generation.saveWorkspace(f.project.id, ws);
  await assert.rejects(f.service.preview(1, f.target), /未配置上传通道/);
  assert.equal(posts, 0);
  assert.equal(wavDuration(wav(3)), 3);
  assert.throws(() => wavDuration(Buffer.from('unverified mp3')), /PCM WAV/);
  assert.throws(() => wavDuration(wav(3).subarray(0, 100)), /不完整/);
});

test('image size mapping respects both pixel area and model capabilities', () => {
  for (const resolution of ['2K', '3K', '4K'] as const) {
    for (const ratio of [
      '1:1',
      '4:3',
      '3:4',
      '16:9',
      '9:16',
      '3:2',
      '2:3',
      '21:9',
    ] as const) {
      const size = arkImageSize({
        model: 'seedream-5.0-lite',
        resolution,
        ratio,
      });
      const [width = 0, height = 0] = size.split('x').map(Number);
      assert.ok(width * height >= 3686400 && width * height <= 16777216);
    }
  }
  assert.throws(
    () =>
      arkImageSize({ model: 'seedream-4.5', resolution: '3K', ratio: '1:1' }),
    /不支持/,
  );
  assert.deepEqual(imageInfo(png(2048, 2048)), {
    mime: 'image/png',
    extension: 'png',
    width: 2048,
    height: 2048,
  });
  assert.throws(
    () => imageInfo(Buffer.from('<html>Not an image</html>')),
    /无法验证/,
  );
});
