import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  parsePackagingArguments,
  stageMediaToolBundle,
} from '../scripts/package-media-tools.mjs';
import { mediaProcess } from '../src/main/export/media-process';
import {
  assertMediaToolLaunch,
  bundledMediaToolLocation,
  createMediaToolBundleReader,
  parseMediaToolBundleManifest,
  verifyMediaToolBundle,
} from '../src/main/media/media-tool-bundle';
import { inspectMediaTool } from '../src/main/media/media-tool-diagnostics';
import { MediaToolSettings } from '../src/main/media/media-tool-settings';
import { resolveMediaToolPair } from '../src/main/media/media-tools';
import { transcodeProxy } from '../src/main/media/transcode-proxy';
import { AppStore } from '../src/main/storage/app-store';
import type {
  MediaToolLocation,
  MediaToolResult,
} from '../src/shared/media-tools';
import { mediaToolBundleFixture } from './media-tool-bundle-fixture';

const target = { platform: 'darwin' as const, arch: 'arm64' };

test('versioned manifest requires matched supported target, both tools, provenance and notices', async (t) => {
  const f = await mediaToolBundleFixture();
  t.after(f.clean);
  assert.deepEqual(
    parseMediaToolBundleManifest(f.manifest, target),
    f.manifest,
  );
  const invalid = [
    { ...f.manifest, version: 2 },
    { ...f.manifest, future: true },
    { ...f.manifest, target: { platform: 'darwin', arch: 'x64' } },
    { ...f.manifest, tools: { ffmpeg: f.manifest.tools.ffmpeg } },
    { ...f.manifest, notices: [] },
    { ...f.manifest, build: { version: '1', source: '' } },
    { ...f.manifest, build: { source: 'test' } },
    { ...f.manifest, license: '' },
    { ...f.manifest, notices: [{ file: 'LICENSE', sha256: 'bad' }] },
    { ...f.manifest, notices: [f.manifest.tools.ffmpeg] },
    {
      ...f.manifest,
      notices: [{ ...f.manifest.tools.ffmpeg, file: 'BIN/FFMPEG' }],
    },
    {
      ...f.manifest,
      notices: [{ ...f.manifest.tools.ffmpeg, file: 'bin/ffmpeg/NOTICE' }],
    },
  ];
  for (const value of invalid)
    assert.throws(
      () => parseMediaToolBundleManifest(value, target),
      /Invalid media tool bundle/,
    );
  for (const file of [
    '../private',
    '/private',
    'C:/private',
    'C:\\private',
    '\\\\host\\private',
    'bin/../private',
    './bin/ffmpeg',
    'bin//ffmpeg',
    'bin/tool:stream',
    'bin/NUL',
    'bin/ffmpeg.',
    '.env',
  ])
    assert.throws(
      () =>
        parseMediaToolBundleManifest(
          {
            ...f.manifest,
            tools: {
              ...f.manifest.tools,
              ffmpeg: { ...f.manifest.tools.ffmpeg, file },
            },
          },
          target,
        ),
      /Invalid media tool bundle/,
      file,
    );
  assert.throws(
    () =>
      parseMediaToolBundleManifest(f.manifest, {
        platform: 'linux',
        arch: 'arm64',
      }),
    /target/,
  );
  assert.throws(
    () =>
      parseMediaToolBundleManifest(f.manifest, {
        platform: 'darwin',
        arch: 'universal',
      }),
    /target/,
  );
});

test('verification checks exact files, nonempty notices, pair hashes, permissions and symlinks', async (t) => {
  const f = await mediaToolBundleFixture();
  t.after(f.clean);
  const verified = verifyMediaToolBundle(f.directory, target);
  assert.equal(verified.files.length, 4);
  assert.equal(verified.commands.ffmpeg, join(f.directory, 'bin/ffmpeg'));
  assert.throws(() => verifyMediaToolBundle('relative', target), /absolute/);
  const notice = join(f.directory, 'licenses/NOTICE.txt');
  const original = await readFile(notice);
  await rm(notice);
  assert.throws(
    () => verifyMediaToolBundle(f.directory, target),
    /missing declared file/,
  );
  await writeFile(notice, 'changed');
  assert.throws(() => verifyMediaToolBundle(f.directory, target), /SHA-256/);
  await writeFile(notice, '');
  assert.throws(() => verifyMediaToolBundle(f.directory, target), /nonempty/);
  await writeFile(notice, original);
  await writeFile(join(f.directory, 'undeclared.txt'), 'must not ship');
  assert.throws(() => verifyMediaToolBundle(f.directory, target), /undeclared/);
  await rm(join(f.directory, 'undeclared.txt'));
  await mkdir(join(f.directory, 'unlisted'));
  assert.throws(() => verifyMediaToolBundle(f.directory, target), /undeclared/);
  await rm(join(f.directory, 'unlisted'), { recursive: true });
  const tool = join(f.directory, 'bin/ffprobe');
  await rm(tool);
  await symlink(join(f.directory, 'bin/ffmpeg'), tool);
  assert.throws(
    () => verifyMediaToolBundle(f.directory, target),
    /symbolic link/,
  );
  await rm(tool);
  await writeFile(tool, 'inert ffprobe fixture', { mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(tool, 0o600);
    assert.throws(() => verifyMediaToolBundle(f.directory, target), /EACCES/);
    await chmod(tool, 0o700);
  }
  await rename(join(f.directory, 'licenses'), join(f.base, 'licenses'));
  await symlink(
    join(f.base, 'licenses'),
    join(f.directory, 'licenses'),
    'junction',
  );
  assert.throws(
    () => verifyMediaToolBundle(f.directory, target),
    /symbolic link/,
  );
  const rootLink = join(f.base, 'root-link');
  await symlink(f.directory, rootLink, 'junction');
  assert.throws(() => verifyMediaToolBundle(rootLink, target), /symbolic link/);
});

test('default-off and absent bundle preserve PATH; valid bundle sits below both explicit override sources', async (t) => {
  const f = await mediaToolBundleFixture();
  t.after(f.clean);
  const options = { ...target, env: {}, executable: () => false };
  assert.equal(resolveMediaToolPair(undefined, options).ffmpeg.source, 'path');
  assert.equal(
    resolveMediaToolPair(undefined, {
      ...options,
      bundleDirectory: join(f.base, 'absent'),
    }).ffmpeg.source,
    'path',
  );
  const pair = resolveMediaToolPair(
    { ffmpeg: '/saved/ffmpeg', ffprobe: null },
    { ...options, bundleDirectory: f.directory },
  );
  assert.equal(pair.ffmpeg.source, 'saved');
  assert.equal(pair.ffprobe.source, 'bundled');
  assert.equal(pair.ffprobe.command, join(f.directory, 'bin/ffprobe'));
  assert.ok(Object.isFrozen(pair) && Object.isFrozen(pair.ffprobe));
  const environment = resolveMediaToolPair(
    { ffmpeg: '/saved/ffmpeg', ffprobe: null },
    {
      ...options,
      bundleDirectory: f.directory,
      env: { FFMPEG_PATH: '/env/ffmpeg' },
    },
  );
  assert.equal(environment.ffmpeg.source, 'environment');
  assert.equal(environment.ffprobe.source, 'bundled');
});

test('runtime reader detects tampering even with restored mtime and never loses a previously present bundle silently', async (t) => {
  const f = await mediaToolBundleFixture();
  t.after(f.clean);
  const read = createMediaToolBundleReader(f.directory, target);
  assert.equal(read().status, 'verified');
  assert.equal(read().status, 'verified');
  const file = join(f.directory, 'bin/ffmpeg');
  const info = await lstat(file);
  await writeFile(file, 'other ffmpeg fixture');
  await utimes(file, info.atime, info.mtime);
  assert.equal(read().status, 'invalid');
  await writeFile(file, 'inert ffmpeg fixture');
  assert.equal(read().status, 'verified');
  await rm(f.directory, { recursive: true });
  assert.equal(read().status, 'invalid');
});

test('invalid bundle does not run diagnoses or tasks, remains editable, and explicit saved overrides still work', async (t) => {
  const f = await mediaToolBundleFixture();
  t.after(f.clean);
  const store = new AppStore(join(f.base, 'app.sqlite'), f.base);
  const inspected: MediaToolLocation[] = [];
  const service = new MediaToolSettings(store, {
    ...target,
    env: {},
    bundleDirectory: f.directory,
    inspect: async (location): Promise<MediaToolResult> => {
      inspected.push(location);
      return {
        ...location,
        status: 'available',
        version: 'fixture',
        detail: null,
      };
    },
  });
  t.after(async () => {
    await service.close();
    store.close();
  });
  const old = service.snapshot();
  assert.equal(old.ffmpeg.source, 'bundled');
  assert.equal(inspected.length, 0);
  assert.equal(store.hasSetting('mediaToolSettings'), false);
  await writeFile(join(f.directory, 'manifest.json'), '{}');
  const state = service.state();
  assert.equal(state.error, null);
  assert.ok(state.locations.ffmpeg.unavailableReason);
  assert.throws(() => service.snapshot(), /校验失败/);
  const report = await service.check();
  assert.deepEqual(
    report.tools.map(({ status }) => status),
    ['invalid', 'invalid'],
  );
  assert.equal(inspected.length, 0);
  let launched = false;
  const diagnosis = await inspectMediaTool(state.locations.ffmpeg, {
    launch: () => {
      launched = true;
      throw new Error('unexpected');
    },
  });
  assert.equal(diagnosis.status, 'invalid');
  assert.equal(launched, false);
  const signal = new AbortController().signal;
  await assert.rejects(
    mediaProcess(state.locations.ffmpeg, [], signal),
    /校验失败/,
  );
  await assert.rejects(
    transcodeProxy('unused-input', 'unused-output', signal, state.locations),
    /校验失败/,
  );
  const selected = join(f.base, 'chosen-tool');
  await writeFile(selected, 'inert override fixture', { mode: 0o700 });
  await service.choose(
    'ffmpeg',
    async () => selected,
    () => {},
  );
  assert.equal(service.state().locations.ffmpeg.source, 'saved');
  assert.throws(() => service.snapshot(), /校验失败/); // FFprobe is still affected.
  await service.choose(
    'ffprobe',
    async () => selected,
    () => {},
  );
  assert.equal(service.snapshot().ffprobe.source, 'saved');
  assert.deepEqual(store.get('mediaToolSettings'), {
    version: 1,
    ffmpeg: selected,
    ffprobe: selected,
  });
  assert.equal(old.ffmpeg.command, join(f.directory, 'bin/ffmpeg'));
  const reset = await service.reset('ffmpeg', () => {});
  assert.equal(reset.report.tools[0]?.status, 'invalid');
  assert.equal(reset.settings.paths?.ffmpeg, null);
  const envPair = resolveMediaToolPair(undefined, {
    ...target,
    bundleDirectory: f.directory,
    env: { FFMPEG_PATH: '/env/ffmpeg', FFPROBE_PATH: '/env/ffprobe' },
  });
  assert.equal(envPair.ffmpeg.source, 'environment');
  assert.equal(envPair.ffprobe.unavailableReason, undefined);
});

test('packaging accepts only explicit local bundle arguments and stages a verified exact copy', async (t) => {
  const f = await mediaToolBundleFixture();
  t.after(f.clean);
  assert.deepEqual(parsePackagingArguments(['dir']), {
    mode: 'dir',
    bundleDirectory: undefined,
    outputDirectory: undefined,
  });
  assert.deepEqual(
    parsePackagingArguments(['local', '--media-tools', f.directory]),
    { mode: 'local', bundleDirectory: f.directory, outputDirectory: undefined },
  );
  assert.deepEqual(
    parsePackagingArguments([
      'dir',
      '--output',
      f.base,
      '--media-tools',
      f.directory,
    ]),
    { mode: 'dir', bundleDirectory: f.directory, outputDirectory: f.base },
  );
  for (const args of [
    ['dir', '--output'],
    ['dir', '--output', 'relative'],
    ['dir', '--output', f.base, '--output', f.base],
    ['dir', '--media-tools'],
    ['local', '--media-tools', 'relative'],
    ['dir', '--publish', 'always'],
    ['dir', '--media-tools', f.directory, '--x64'],
  ])
    assert.throws(
      () => parsePackagingArguments(args),
      /publishing and signing are disabled/,
    );
  const destination = join(f.base, 'owned-staging');
  const staged = await stageMediaToolBundle(f.directory, destination, target);
  assert.deepEqual(staged.manifest, f.manifest);
  assert.deepEqual(staged.files, [
    'bin/ffmpeg',
    'bin/ffprobe',
    'licenses/NOTICE.txt',
    'manifest.json',
  ]);
  if (process.platform !== 'win32')
    assert.equal(
      (await lstat(join(destination, 'bin/ffmpeg'))).mode & 0o111,
      0o100,
    );
  await assert.rejects(
    stageMediaToolBundle(f.directory, destination, target),
    /EEXIST/,
  );
  await writeFile(join(f.directory, 'bin/ffprobe'), 'corrupt');
  await assert.rejects(
    stageMediaToolBundle(f.directory, join(f.base, 'never-created'), target),
    /SHA-256/,
  );
  await assert.rejects(lstat(join(f.base, 'never-created')), {
    code: 'ENOENT',
  });
  assert.equal((await lstat(f.directory)).isDirectory(), true);
});

test('bundled launch authority cannot be forged or copied and captures original manifest and file identity', async (t) => {
  const f = await mediaToolBundleFixture();
  t.after(f.clean);
  const bundle = verifyMediaToolBundle(f.directory, target);
  const location = bundledMediaToolLocation(bundle, 'ffmpeg');
  assert.doesNotThrow(() => assertMediaToolLaunch(location));
  assert.throws(
    () => bundledMediaToolLocation({ ...bundle }, 'ffmpeg'),
    /original verification proof/,
  );
  const copied = { ...location };
  assert.throws(() => assertMediaToolLaunch(copied), /verification proof/);
  let launches = 0;
  const launch = () => {
    launches++;
    throw new Error('unexpected launch');
  };
  assert.equal((await inspectMediaTool(copied, { launch })).status, 'invalid');
  assert.equal(launches, 0);
  const signal = new AbortController().signal;
  await assert.rejects(mediaProcess(copied, [], signal), /verification proof/);
  await assert.rejects(
    transcodeProxy('unused', 'unused', signal, {
      ffmpeg: copied,
      ffprobe: { ...location, name: 'ffprobe' },
    }),
    /verification proof/,
  );
  const original = await readFile(join(f.directory, 'bin/ffmpeg'));
  await rm(join(f.directory, 'bin/ffmpeg'));
  await writeFile(join(f.directory, 'bin/ffmpeg'), original, { mode: 0o700 });
  assert.throws(() => assertMediaToolLaunch(location), /changed after/);
  const fresh = bundledMediaToolLocation(
    verifyMediaToolBundle(f.directory, target),
    'ffmpeg',
  );
  assert.doesNotThrow(() => assertMediaToolLaunch(fresh));
  await f.save(); // Even an equivalent manifest rewrite changes this task's captured identity.
  assert.equal((await inspectMediaTool(fresh, { launch })).status, 'invalid');
  assert.equal(launches, 0);
});
