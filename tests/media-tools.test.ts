import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { mediaProcess } from '../src/main/export/media-process';
import {
  inspectMediaTool,
  MediaToolDiagnostics,
} from '../src/main/media/media-tool-diagnostics';
import { resolveMediaTool } from '../src/main/media/media-tools';
import type {
  MediaToolLocation,
  MediaToolResult,
} from '../src/shared/media-tools';

const tool: MediaToolLocation = {
  name: 'ffmpeg',
  command: 'ffmpeg',
  source: 'path',
};
function fakeProcess() {
  const events = new EventEmitter();
  const signals: (string | number | undefined)[] = [];
  const child = Object.assign(events, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: (signal?: string | number) => {
      signals.push(signal);
      return true;
    },
    unref: () => {},
  }) as unknown as ChildProcess;
  return { child, signals };
}

test('explicit tool configuration wins unchanged and never falls back to another executable', () => {
  const configured = '/custom tool/ffmpeg; --not-a-shell';
  let checked = false;
  assert.deepEqual(
    resolveMediaTool('ffmpeg', {
      env: { FFMPEG_PATH: configured, PATH: '/bin' },
      platform: 'darwin',
      executable: () => {
        checked = true;
        return true;
      },
    }),
    { name: 'ffmpeg', command: configured, source: 'environment' },
  );
  assert.equal(checked, false);
});

test('macOS prefers executable PATH entries, then verified standard locations; other systems keep native PATH lookup', () => {
  const executable = (file: string) =>
    [
      '/custom/ffprobe',
      '/opt/homebrew/bin/ffprobe',
      '/usr/local/bin/ffprobe',
    ].includes(file);
  const options = { platform: 'darwin' as const, executable };
  assert.deepEqual(
    resolveMediaTool('ffprobe', { ...options, env: { PATH: '/custom:/bin' } }),
    {
      name: 'ffprobe',
      command: '/custom/ffprobe',
      source: 'path',
    },
  );
  assert.deepEqual(
    resolveMediaTool('ffprobe', { ...options, env: { PATH: '/bin' } }),
    {
      name: 'ffprobe',
      command: '/opt/homebrew/bin/ffprobe',
      source: 'standard-location',
    },
  );
  assert.equal(
    resolveMediaTool('ffprobe', {
      ...options,
      env: { PATH: '/bin' },
      executable: (file) => file === '/usr/local/bin/ffprobe',
    }).command,
    '/usr/local/bin/ffprobe',
  );
  for (const platform of ['darwin', 'win32', 'linux'] as const)
    assert.deepEqual(
      resolveMediaTool('ffprobe', {
        env: {},
        platform,
        executable: () => false,
      }),
      {
        name: 'ffprobe',
        command: 'ffprobe',
        source: 'path',
      },
    );
});

test('version diagnosis accepts only the expected tool banner after successful exit', async () => {
  for (const [output, code, status] of [
    ['ffmpeg version 8.1.2 Copyright\nconfiguration: test\n', 0, 'available'],
    ['ffprobe version 8.1.2\n', 0, 'invalid'],
    ['ffmpeg version 8.1.2\n', 1, 'failed'],
  ] as const) {
    const { child } = fakeProcess();
    const result = inspectMediaTool(tool, {
      launch: (command, args) => {
        assert.equal(command, 'ffmpeg');
        assert.deepEqual(args, ['-version']);
        return child;
      },
    });
    child.stdout?.emit('data', output);
    child.emit('close', code);
    const report = await result;
    assert.equal(report.status, status);
    assert.equal(report.version, status === 'available' ? '8.1.2' : null);
  }
});

test('startup errors distinguish missing files and permission failures without raw spawn messages', async () => {
  for (const [code, status] of [
    ['ENOENT', 'missing'],
    ['EACCES', 'permission-denied'],
    ['EPERM', 'permission-denied'],
  ] as const) {
    const { child } = fakeProcess();
    const result = inspectMediaTool(tool, { launch: () => child });
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code }));
    const report = await result;
    assert.equal(report.status, status);
    assert.match(report.detail ?? '', /设置 → 视频处理/);
    assert.doesNotMatch(report.detail ?? '', /spawn/);
  }
});

test('timeout and excessive output terminate the version check instead of holding app exit or growing memory', async () => {
  const slow = fakeProcess();
  const timed = await inspectMediaTool(tool, {
    launch: () => slow.child,
    timeoutMs: 10,
  });
  assert.equal(timed.status, 'timeout');
  assert.deepEqual(slow.signals, ['SIGKILL']);
  const noisy = fakeProcess();
  const result = inspectMediaTool(tool, { launch: () => noisy.child });
  noisy.child.stdout?.emit('data', 'x'.repeat(65 * 1024));
  assert.equal((await result).status, 'invalid');
  assert.deepEqual(noisy.signals, ['SIGKILL']);
  noisy.child.emit('close', 0);
});

test('diagnostics are idle until requested and share concurrent requests without caching stale checks forever', async () => {
  let calls = 0;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const diagnostics = new MediaToolDiagnostics(
    async (location): Promise<MediaToolResult> => {
      calls++;
      await pending;
      return {
        ...location,
        status: 'available',
        version: '8.1.2',
        detail: null,
      };
    },
  );
  assert.equal(calls, 0);
  const first = diagnostics.check();
  assert.equal(diagnostics.check(), first);
  assert.equal(calls, 2);
  finish();
  assert.equal((await first).tools.length, 2);
  await diagnostics.check();
  assert.equal(calls, 4);
});

test('missing configured commands are never interpreted by a shell and export reports the same actionable error', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'afflatus-tools-'));
  const marker = join(folder, 'must-not-exist');
  const location: MediaToolLocation = {
    name: 'ffprobe',
    command: `${join(folder, 'missing')}; touch ${marker}`,
    source: 'environment',
  };
  try {
    assert.equal((await inspectMediaTool(location)).status, 'missing');
    await assert.rejects(access(marker));
    await assert.rejects(
      mediaProcess(location, ['-version'], new AbortController().signal),
      /未找到 FFprobe.*设置 → 视频处理/,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
