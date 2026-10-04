import assert from 'node:assert/strict';
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
import { ExportWork } from '../src/main/export/export-work';
import { exportDimensions } from '../src/main/export/media-probe';
import {
  cleanPendingOutput,
  publishOutput,
  validateOutputPath,
} from '../src/main/export/publish-output';
import { SequenceExportService } from '../src/main/export/sequence-export-service';
import { ProjectService } from '../src/main/projects/project-service';
import { AppStore } from '../src/main/storage/app-store';
import { WriteGate } from '../src/main/storage/write-gate';
import {
  DEFAULT_EXPORT_OPTIONS,
  exportIsActive,
  validateExportOptions,
} from '../src/shared/export';

async function fixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-export-')),
  );
  const projectRoot = join(base, 'projects');
  const data = join(base, 'app');
  await mkdir(projectRoot);
  await mkdir(data);
  const store = new AppStore(join(data, 'app.sqlite'), projectRoot);
  return {
    base,
    projectRoot,
    data,
    store,
    async dispose() {
      store.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('export options bound format choices and preserve the first clip aspect without upscaling', () => {
  assert.deepEqual(validateExportOptions(undefined), DEFAULT_EXPORT_OPTIONS);
  assert.throws(() =>
    validateExportOptions({ resolution: '8k', frameRate: 30 }),
  );
  assert.throws(() =>
    validateExportOptions({ resolution: '1080p', frameRate: 31 }),
  );
  assert.deepEqual(
    exportDimensions({ width: 2160, height: 3840 }, DEFAULT_EXPORT_OPTIONS),
    { width: 1080, height: 1920 },
  );
  assert.deepEqual(
    exportDimensions({ width: 640, height: 360 }, DEFAULT_EXPORT_OPTIONS),
    { width: 640, height: 360 },
  );
  assert.deepEqual(
    exportDimensions(
      { width: 3840, height: 2160 },
      { resolution: '720p', frameRate: 30 },
    ),
    { width: 1280, height: 720 },
  );
});

test('publication refuses existing files and project/app destinations; cancellation leaves no partial output', async () => {
  const f = await fixture();
  try {
    const source = join(f.base, 'source');
    const target = join(f.base, '成片.mp4');
    await writeFile(source, 'verified result bytes');
    await assert.rejects(
      validateOutputPath(join(f.projectRoot, 'out.mp4'), f.projectRoot, f.data),
      /项目库/,
    );
    await assert.rejects(
      validateOutputPath(join(f.data, 'out.mp4'), f.projectRoot, f.data),
      /应用数据/,
    );
    await assert.rejects(
      validateOutputPath('relative.mp4', f.projectRoot, f.data),
    );
    await publishOutput(source, target, f.store, new AbortController().signal);
    assert.equal(await readFile(target, 'utf8'), 'verified result bytes');
    await assert.rejects(
      validateOutputPath(target, f.projectRoot, f.data),
      /已存在/,
    );
    await writeFile(source, 'different bytes');
    await assert.rejects(
      publishOutput(source, target, f.store, new AbortController().signal),
      { code: 'EEXIST' },
    );
    assert.equal(await readFile(target, 'utf8'), 'verified result bytes');
    const cancelled = join(f.base, 'cancelled.mp4');
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      publishOutput(source, cancelled, f.store, abort.signal),
    );
    await assert.rejects(readFile(cancelled), { code: 'ENOENT' });
    assert.equal(
      (await readdir(f.base)).some((name) => name.endsWith('.part')),
      false,
    );
  } finally {
    await f.dispose();
  }
});

test('interrupted work cleanup removes only registered identities and retains unknown files', async () => {
  const f = await fixture();
  try {
    const work = new ExportWork(f.store, join(f.data, 'export-work'));
    const registered = await work.create('mkv');
    await writeFile(registered, 'partial');
    const unknown = join(work.root, 'personal.mp4');
    await writeFile(unknown, 'keep');
    await new ExportWork(f.store, work.root).clean();
    assert.deepEqual(await readdir(work.root), ['personal.mp4']);
    assert.equal(await readFile(unknown, 'utf8'), 'keep');
    const unrelated = join(f.base, 'unrelated.part');
    await writeFile(unrelated, 'keep');
    f.store.set('exportPendingOutputs', [
      {
        file: unrelated,
        device: -1,
        inode: -1,
      },
    ]);
    await cleanPendingOutput(f.store);
    assert.equal(await readFile(unrelated, 'utf8'), 'keep');
  } finally {
    await f.dispose();
  }
});

test('only unfinished export states are active', () => {
  for (const status of [
    'queued',
    'preparing',
    'encoding',
    'finalizing',
  ] as const)
    assert.equal(
      exportIsActive({ status } as Parameters<typeof exportIsActive>[0]),
      true,
    );
  for (const status of ['completed', 'cancelled', 'failed'] as const)
    assert.equal(
      exportIsActive({ status } as Parameters<typeof exportIsActive>[0]),
      false,
    );
});

test('restart reports interrupted exports and tolerates an offline destination without discarding its cleanup record', async () => {
  const f = await fixture();
  const gate = new WriteGate();
  const service = new SequenceExportService(
    new ProjectService(f.store, gate),
    gate,
    f.store,
    f.data,
  );
  try {
    f.store.set('sequenceExports', [
      { id: 'unfinished', status: 'encoding', progress: 0.2 },
    ]);
    const offline = {
      file: join(f.base, 'offline-disk', 'work.part'),
      device: 1,
      inode: 2,
    };
    f.store.set('exportPendingOutputs', [offline]);
    await service.recover();
    assert.equal(service.get('unfinished').status, 'failed');
    assert.match(service.get('unfinished').error ?? '', /应用中断/);
    assert.deepEqual(f.store.get('exportPendingOutputs'), [offline]);
  } finally {
    await service.close();
    await f.dispose();
  }
});
