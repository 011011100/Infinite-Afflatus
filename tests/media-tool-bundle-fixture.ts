import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaToolBundleManifest } from '../src/shared/media-tool-bundle';

/** Inert controlled bytes, never real or downloaded FFmpeg binaries or legal notices. */
export async function mediaToolBundleFixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-bundle-test-')),
  );
  const directory = join(base, 'media-tools');
  await mkdir(join(directory, 'bin'), { recursive: true });
  await mkdir(join(directory, 'licenses'));
  const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const manifest: MediaToolBundleManifest = {
    version: 1,
    target: { platform: 'darwin', arch: 'arm64' },
    build: {
      version: 'test-only-1',
      source: 'inert test fixture, never distributable media tools',
    },
    license: 'LicenseRef-TestFixture-NotLegalApproval',
    tools: {
      ffmpeg: { file: 'bin/ffmpeg', sha256: digest('inert ffmpeg fixture') },
      ffprobe: { file: 'bin/ffprobe', sha256: digest('inert ffprobe fixture') },
    },
    notices: [
      {
        file: 'licenses/NOTICE.txt',
        sha256: digest('Controlled test text. No license claim.'),
      },
    ],
  };
  await writeFile(join(directory, 'bin/ffmpeg'), 'inert ffmpeg fixture', {
    mode: 0o700,
  });
  await writeFile(join(directory, 'bin/ffprobe'), 'inert ffprobe fixture', {
    mode: 0o700,
  });
  await writeFile(
    join(directory, 'licenses/NOTICE.txt'),
    'Controlled test text. No license claim.',
  );
  const save = () =>
    writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await save();
  return {
    base,
    directory,
    manifest,
    save,
    clean: () => rm(base, { recursive: true, force: true }),
  };
}
