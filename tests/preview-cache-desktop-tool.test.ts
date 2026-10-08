import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { run } = require('./browser/preview-cache-desktop-tool.cjs');
const { syntheticTrimVideo } = require('./browser/synthetic-trim-video.mjs');
const probe = [
  '-v',
  'error',
  '-select_streams',
  'v:0',
  '-show_entries',
  'stream=width,height,duration,start_time,avg_frame_rate:format=duration',
  '-of',
  'json',
];

test('desktop controlled tool accepts only known synthetic media in owned disposable work files', async () => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-cache-tool-test-')),
  );
  const owner = randomUUID();
  const profile = join(base, 'profile');
  const work = join(profile, 'preview-work');
  const input = join(work, 'input.source');
  const output = join(work, 'output.mp4');
  const unrelated = join(base, 'unrelated.mp4');
  const environment = {
    AFFLATUS_USER_DATA: profile,
    AFFLATUS_CACHE_FIXTURE_OWNER: owner,
  };
  try {
    await mkdir(work, { recursive: true });
    await writeFile(join(base, '.fixture-owner'), owner, { flag: 'wx' });
    await writeFile(input, syntheticTrimVideo, { flag: 'wx' });
    await writeFile(output, '', { flag: 'wx' });
    await writeFile(unrelated, 'Keep unrelated bytes.', { flag: 'wx' });
    const encode = ['-i', input, '-c:v', 'libx264', output];
    await assert.rejects(
      run('ffmpeg', base, encode, {
        ...environment,
        AFFLATUS_CACHE_FIXTURE_OWNER: 'wrong-owner',
      }),
    );
    assert.equal((await readFile(output)).length, 0);
    await assert.rejects(
      run(
        'ffmpeg',
        base,
        ['-i', input, '-c:v', 'libx264', unrelated],
        environment,
      ),
      /disposable/,
    );
    assert.equal(await readFile(unrelated, 'utf8'), 'Keep unrelated bytes.');
    await writeFile(input, 'Not the synthetic fixture.');
    await assert.rejects(run('ffmpeg', base, encode, environment));
    assert.equal((await readFile(output)).length, 0);
    await writeFile(input, syntheticTrimVideo);
    const before = JSON.parse(
      await run('ffprobe', base, [...probe, input], environment),
    );
    assert.equal(before.streams[0].duration, '8');
    await run('ffmpeg', base, encode, environment);
    assert.deepEqual(await readFile(input), syntheticTrimVideo);
    assert.deepEqual(await readFile(output), syntheticTrimVideo);
    assert.deepEqual(
      JSON.parse(await run('ffprobe', base, [...probe, output], environment)),
      before,
    );
    await assert.rejects(
      run('ffmpeg', base, encode, environment),
      /Never overwrite/,
    );
    assert.deepEqual(await readFile(output), syntheticTrimVideo);
  } finally {
    assert.equal(await readFile(join(base, '.fixture-owner'), 'utf8'), owner);
    await rm(base, { recursive: true, force: true });
  }
});
