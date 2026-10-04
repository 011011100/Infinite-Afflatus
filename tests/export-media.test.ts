import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { probeExportMedia } from '../src/main/export/media-probe';
import { mediaProcess } from '../src/main/export/media-process';
import { SequenceExportService } from '../src/main/export/sequence-export-service';
import { fingerprint, localFileStream } from '../src/main/storage/files';
import { Library } from '../src/main/storage/library';
import { exportIsActive, type SequenceExportJob } from '../src/shared/export';

const realMedia = process.env.AFFLATUS_MEDIA_TESTS === '1';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const encode = (args: string[]) =>
  execFileSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args],
    { timeout: 60_000 },
  );
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

test('cancelling a running FFmpeg process waits for exit and rejects the job', {
  skip: !realMedia,
  timeout: 10_000,
}, async () => {
  const abort = new AbortController();
  const processing = mediaProcess(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-re',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=16x16:r=10',
      '-t',
      '30',
      '-f',
      'null',
      '-',
    ],
    abort.signal,
  );
  const timer = setTimeout(() => abort.abort(), 100);
  try {
    await assert.rejects(processing, { name: 'AbortError' });
  } finally {
    clearTimeout(timer);
  }
});

async function fixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-export-media-')),
  );
  const data = join(base, 'app');
  const library = await Library.open(data, join(base, 'projects'));
  const { project } = await library.projects.create('真实导出验证');
  const first = join(base, 'first.mp4');
  const second = join(base, 'second.mp4');
  encode([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=160x90:r=24:d=0.6',
    '-f',
    'lavfi',
    '-i',
    'color=c=green:s=160x90:r=24:d=0.6',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100:duration=1.2',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map',
    '[v]',
    '-map',
    '2:a',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    first,
  ]);
  encode([
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=90x160:r=25:d=1.2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    second,
  ]);
  for (const [index, file] of [first, second].entries()) {
    await library.acceptResult(
      {
        projectId: project.id,
        resultKey: `clip:${index}`,
        name: `clip${index}.mp4`,
        kind: 'video',
        extension: 'mp4',
      },
      await localFileStream(file),
    );
  }
  await library.saves.idle();
  const snapshot = await library.projects.open(project.id);
  const assets = snapshot.assets;
  assert.equal(assets.length, 2);
  const card = {
    id: snapshot.canvas.cards[0]?.id ?? '',
    position: { x: 100, y: 100 },
    assetIds: assets.map((asset) => asset.id),
    trims: {
      [assets[0]?.id ?? '']: { start: 0.65, end: 1.05 },
      [assets[1]?.id ?? '']: { start: 0.1, end: 0.5 },
    },
  };
  await library.projects.patchCanvas(project.id, {
    before: snapshot.canvas.cards,
    after: [card],
  });
  return {
    base,
    data,
    library,
    project,
    assets,
    card,
    async dispose() {
      await library.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function finish(
  service: SequenceExportService,
  id: string,
): Promise<SequenceExportJob> {
  const deadline = Date.now() + 60_000;
  while (exportIsActive(service.get(id))) {
    if (Date.now() > deadline) throw new Error('export timeout');
    await tick();
  }
  return service.get(id);
}

test('real FFmpeg exports saved trim/order, mixed dimensions/fps, audio and silence while migration proceeds', {
  skip: !realMedia,
  timeout: 90_000,
}, async () => {
  const f = await fixture();
  let migration: Promise<void> | undefined;
  const phases = new Set<string>();
  const service = new SequenceExportService(
    f.library.projects,
    f.library.gate,
    f.library.store,
    f.data,
    () => {
      const current = service.list()[0];
      if (!current) return;
      phases.add(current.status);
      if (current.status === 'encoding' && !migration) {
        migration = (async () => {
          const target = join(f.base, 'moved-projects');
          await mkdir(target);
          const preview = await f.library.migration.prepare(target);
          await f.library.migration.start(preview.token);
          await f.library.migration.idle();
        })();
      }
    },
  );
  try {
    const target = join(f.base, '导出 合成.mp4');
    const job = await service.start(f.project.id, f.card.id, target);
    await assert.rejects(
      service.start(f.project.id, f.card.id, join(f.base, 'other.mp4')),
      /正在导出/,
    );
    const result = await finish(service, job.id);
    assert.equal(result.status, 'completed', result.error ?? '');
    assert.equal(result.progress, 1);
    assert.equal(result.duration, 0.8);
    await migration;
    const metadata = await probeExportMedia(
      target,
      new AbortController().signal,
    );
    assert.deepEqual(
      {
        width: metadata.width,
        height: metadata.height,
        audio: metadata.hasAudio,
      },
      { width: 160, height: 90, audio: true },
    );
    assert.ok(
      Math.abs(metadata.duration - 0.8) < 0.1,
      `duration ${metadata.duration}`,
    );
    const pixel = (time: number) =>
      encode([
        '-ss',
        String(time),
        '-i',
        target,
        '-frames:v',
        '1',
        '-vf',
        'crop=2:2:78:44',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ]);
    const green = pixel(0.1);
    assert.ok(
      (green[1] ?? 0) > 80 && (green[0] ?? 255) < 30 && (green[2] ?? 255) < 30,
      `trimmed green ${green}`,
    );
    const blue = pixel(0.6);
    assert.ok(
      (blue[2] ?? 0) > 200 && (blue[0] ?? 255) < 30,
      `second blue ${blue}`,
    );
    const samples = (time: number) =>
      encode([
        '-ss',
        String(time),
        '-i',
        target,
        '-t',
        '0.1',
        '-vn',
        '-ar',
        '48000',
        '-ac',
        '1',
        '-f',
        'f32le',
        'pipe:1',
      ]);
    const energy = (bytes: Buffer) => {
      let total = 0;
      for (let offset = 0; offset < bytes.length; offset += 4)
        total += Math.abs(bytes.readFloatLE(offset));
      return total / (bytes.length / 4);
    };
    assert.ok(energy(samples(0.1)) > 0.01);
    assert.ok(energy(samples(0.6)) < 0.001);
    assert.ok(
      phases.has('preparing') &&
        phases.has('encoding') &&
        phases.has('finalizing'),
    );
    for (const asset of f.assets) {
      const file = join(f.library.store.root, f.project.id, asset.relativePath);
      assert.equal((await fingerprint(file)).sha256, asset.sha256);
    }
    await service.close();
    assert.deepEqual(await readdir(join(f.data, 'export-work')), []);
  } finally {
    await service.close();
    await f.dispose();
  }
});

test('real export cancellation and invalid input keep original files and never publish output', {
  skip: !realMedia,
  timeout: 90_000,
}, async () => {
  const f = await fixture();
  const service = new SequenceExportService(
    f.library.projects,
    f.library.gate,
    f.library.store,
    f.data,
    () => {
      const job = service.list()[0];
      if (job?.status === 'encoding') service.cancel(job.id);
    },
  );
  try {
    const target = join(f.base, 'cancelled.mp4');
    const job = await service.start(f.project.id, f.card.id, target);
    assert.equal((await finish(service, job.id)).status, 'cancelled');
    await service.close();
    await assert.rejects(readFile(target), { code: 'ENOENT' });
    assert.deepEqual(await readdir(join(f.data, 'export-work')), []);
    const first = f.assets[0];
    assert.ok(first);
    const source = join(f.library.store.root, f.project.id, first.relativePath);
    await writeFile(source, 'external corruption');
    const failed = new SequenceExportService(
      f.library.projects,
      f.library.gate,
      f.library.store,
      f.data,
    );
    const failedJob = await failed.start(f.project.id, f.card.id, target);
    const result = await finish(failed, failedJob.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /素材内容已变化/);
    await failed.close();
    await assert.rejects(readFile(target), { code: 'ENOENT' });
    assert.equal(await readFile(source, 'utf8'), 'external corruption');
  } finally {
    await service.close();
    await f.dispose();
  }
});
