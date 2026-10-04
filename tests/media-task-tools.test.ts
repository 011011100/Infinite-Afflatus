import assert from 'node:assert/strict';
import childProcess, {
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { SequenceExportService } from '../src/main/export/sequence-export-service';
import { ProxyService } from '../src/main/media/proxy-service';
import { Library } from '../src/main/storage/library';
import { exportIsActive } from '../src/shared/export';
import type { MediaToolPair } from '../src/shared/media-tools';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pair(root: string, version: string): MediaToolPair {
  return Object.freeze({
    ffmpeg: Object.freeze({
      name: 'ffmpeg',
      command: join(root, version, 'ffmpeg'),
      source: 'saved',
    }),
    ffprobe: Object.freeze({
      name: 'ffprobe',
      command: join(root, version, 'ffprobe'),
      source: 'saved',
    }),
  });
}

async function fixture(t: TestContext, count = 2) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-media-tool-snapshot-')),
  );
  const data = join(base, 'app');
  const library = await Library.open(data, join(base, 'projects'));
  const services: { close(): Promise<void> }[] = [];
  t.after(async () => {
    for (const service of services) await service.close();
    await library.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  });
  const { project } = await library.projects.create('媒体工具快照');
  for (let index = 0; index < count; index++) {
    await library.acceptResult(
      {
        projectId: project.id,
        resultKey: `input:${index}`,
        name: `source-${index}.mp4`,
        kind: 'video',
        extension: 'mp4',
      },
      Readable.from(`unchanged source ${index}`),
    );
  }
  await library.saves.idle();
  const snapshot = await library.projects.open(project.id);
  assert.equal(snapshot.assets.length, count);
  const originals = snapshot.assets.map((asset, index) => ({
    path: join(library.store.root, project.folder, asset.relativePath),
    bytes: Buffer.from(`unchanged source ${index}`),
  }));
  const assertOriginals = async () => {
    for (const file of originals)
      assert.deepEqual(await readFile(file.path), file.bytes);
  };
  return { base, data, library, project, snapshot, services, assertOriginals };
}

interface Invocation {
  command: string;
  args: string[];
}

/** Exercise the real probe/encode pipelines; only the operating-system processes are controlled. */
function mediaProcesses(
  t: TestContext,
  duration: number,
  before: (invocation: Invocation) => Promise<void> = async () => {},
) {
  const calls: Invocation[] = [];
  const launch = ((command: string, args: string[], options: SpawnOptions) => {
    assert.equal(options.shell, false);
    const invocation = { command, args: [...args] };
    calls.push(invocation);
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let closed = false;
    const close = (code: number) => {
      if (closed) return;
      closed = true;
      stdout.end();
      stderr.end();
      events.emit('close', code);
    };
    const child = Object.assign(events, {
      stdout,
      stderr,
      kill: () => {
        queueMicrotask(() => close(1));
        return true;
      },
    }) as unknown as ChildProcess;
    queueMicrotask(() => {
      void (async () => {
        await before(invocation);
        if (closed) return;
        const file = args.at(-1);
        assert.ok(file);
        if (command.endsWith('ffprobe')) {
          const seconds = file.endsWith('.mp4') ? duration : 1;
          stdout.write(
            JSON.stringify({
              streams: [
                {
                  codec_type: 'video',
                  width: 64,
                  height: 64,
                  duration: String(seconds),
                  start_time: '0',
                  avg_frame_rate: '30/1',
                },
                { codec_type: 'audio' },
              ],
              format: { duration: String(seconds) },
            }),
          );
        } else {
          await writeFile(file, 'controlled encoder output');
          stdout.write('out_time_us=1000000\nprogress=end\n');
        }
        close(0);
      })().catch((error) => {
        if (closed) return;
        events.emit('error', error);
        close(1);
      });
    });
    return child;
  }) as typeof childProcess.spawn;
  t.mock.method(childProcess, 'spawn', launch);
  syncBuiltinESMExports();
  return calls;
}

async function finishExport(service: SequenceExportService, id: string) {
  for (let count = 0; count < 1000; count++) {
    const job = service.get(id);
    if (!exportIsActive(job)) {
      assert.equal(job.status, 'completed', job.error ?? '');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('export did not complete');
}

test('one export captures tools before preparation and uses them for every input, segment, concat and output probe; the next export uses new settings', {
  timeout: 10_000,
}, async (t) => {
  const f = await fixture(t);
  const firstCard = f.snapshot.canvas.cards[0];
  assert.ok(firstCard);
  const card = {
    ...firstCard,
    assetIds: f.snapshot.assets.map((asset) => asset.id),
  };
  await f.library.projects.patchCanvas(f.project.id, {
    before: f.snapshot.canvas.cards,
    after: [card],
  });
  const a = pair(f.base, 'A');
  const b = pair(f.base, 'B');
  let current = a;
  let captures = 0;
  const calls = mediaProcesses(t, 2);
  const service = new SequenceExportService(
    f.library.projects,
    f.library.gate,
    f.library.store,
    f.data,
    undefined,
    undefined,
    () => {
      captures++;
      return current;
    },
  );
  f.services.push(service);
  const first = service.start(f.project.id, card.id, join(f.base, 'first.mp4'));
  assert.equal(
    captures,
    1,
    'the snapshot is taken before start reaches any await',
  );
  current = b;
  await finishExport(service, (await first).id);
  assert.deepEqual(
    calls.map((call) => call.command),
    [
      a.ffprobe.command,
      a.ffprobe.command,
      a.ffmpeg.command,
      a.ffmpeg.command,
      a.ffmpeg.command,
      a.ffprobe.command,
    ],
  );
  assert.equal(captures, 1);
  // The completed notification precedes temporary-file cleanup. Wait for that
  // real task to release admission, without reaching into private service state.
  let second: Awaited<ReturnType<typeof service.start>> | undefined;
  for (let attempt = 0; attempt < 1000 && !second; attempt++) {
    try {
      second = await service.start(
        f.project.id,
        card.id,
        join(f.base, 'second.mp4'),
      );
    } catch (error) {
      assert.match(String(error), /已有视频正在导出/);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assert.ok(second);
  await finishExport(service, second.id);
  assert.equal(captures, 2);
  assert.deepEqual(
    calls.slice(6).map((call) => call.command),
    [
      b.ffprobe.command,
      b.ffprobe.command,
      b.ffmpeg.command,
      b.ffmpeg.command,
      b.ffmpeg.command,
      b.ffprobe.command,
    ],
  );
  await service.close();
  assert.deepEqual(await readdir(join(f.data, 'export-work')), []);
  await f.assertOriginals();
});

test('invalid tool settings fail export before a job or output is created and do not prevent a later corrected export', {
  timeout: 10_000,
}, async (t) => {
  const f = await fixture(t, 1);
  let invalid = true;
  const tools = pair(f.base, 'fixed');
  const calls = mediaProcesses(t, 1);
  const service = new SequenceExportService(
    f.library.projects,
    f.library.gate,
    f.library.store,
    f.data,
    undefined,
    undefined,
    () => {
      if (invalid) throw new Error('媒体工具设置不可读取');
      return tools;
    },
  );
  f.services.push(service);
  const card = f.snapshot.canvas.cards[0];
  assert.ok(card);
  const output = join(f.base, 'corrected.mp4');
  await assert.rejects(
    service.start(f.project.id, card.id, output),
    /媒体工具设置不可读取/,
  );
  assert.deepEqual(service.list(), []);
  assert.equal(calls.length, 0);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  invalid = false;
  const job = await service.start(f.project.id, card.id, output);
  await finishExport(service, job.id);
  assert.deepEqual(
    calls.map((call) => call.command),
    [
      tools.ffprobe.command,
      tools.ffmpeg.command,
      tools.ffmpeg.command,
      tools.ffprobe.command,
    ],
  );
  await f.assertOriginals();
});

test('running proxies keep one tool pair, queued generation captures new settings, cache hits need no settings and invalid settings fall back to original media', {
  timeout: 10_000,
}, async (t) => {
  const f = await fixture(t, 3);
  const a = pair(f.base, 'A');
  const b = pair(f.base, 'B');
  let current = a;
  let invalid = false;
  let captures = 0;
  const entered = deferred();
  const release = deferred();
  let firstProbe = true;
  const calls = mediaProcesses(t, 1, async () => {
    if (!firstProbe) return;
    firstProbe = false;
    entered.resolve();
    await release.promise;
  });
  const proxies = new ProxyService(
    f.library.projects,
    f.library.gate,
    f.library.store,
    f.data,
    undefined,
    () => {
      captures++;
      if (invalid) throw new Error('媒体工具设置不可读取');
      return current;
    },
  );
  f.services.push(proxies);
  const [first, second, third] = f.snapshot.assets;
  assert.ok(first && second && third);
  try {
    const running = proxies.ensure(f.project.id, first.id);
    await entered.promise;
    const queued = proxies.ensure(f.project.id, second.id);
    assert.equal(
      captures,
      1,
      'queued generation has not captured stale settings',
    );
    current = b;
    release.resolve();
    assert.deepEqual(await running, { ready: true });
    assert.deepEqual(await queued, { ready: true });
    assert.equal(captures, 2);
    assert.deepEqual(
      calls.map((call) => call.command),
      [
        a.ffprobe.command,
        a.ffmpeg.command,
        a.ffprobe.command,
        b.ffprobe.command,
        b.ffmpeg.command,
        b.ffprobe.command,
      ],
    );
    invalid = true;
    assert.deepEqual(await proxies.ensure(f.project.id, first.id), {
      ready: true,
    });
    assert.equal(
      captures,
      2,
      'an intact cached proxy does not read invalid configuration',
    );
    const warnings = t.mock.method(console, 'warn', () => {});
    assert.deepEqual(await proxies.ensure(f.project.id, third.id), {
      ready: false,
    });
    assert.equal(captures, 3);
    assert.equal(
      calls.length,
      6,
      'invalid settings do not launch a fallback command',
    );
    assert.equal(warnings.mock.callCount(), 1);
    assert.equal(await proxies.file(f.project.id, third.id), null);
    assert.deepEqual(await readdir(join(f.data, 'preview-work')), []);
    await f.assertOriginals();
  } finally {
    release.resolve();
  }
});
