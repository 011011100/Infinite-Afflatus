import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import {
  createPackage,
  createPackageFromStreams,
  extractFile,
} from '@electron/asar';

for (const writer of ['files', 'streams'] as const) {
  test(`ASAR ${writer} writer resolves only after the destination finishes`, async (t) => {
    const base = await mkdtemp(join(tmpdir(), 'afflatus-asar-completion-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const source = join(base, 'source');
    const archive = join(base, 'app.asar');
    const content = Buffer.alloc(1024 * 1024, 0x7b);
    await mkdir(source);
    const input = join(source, 'payload.bin');
    await writeFile(input, content);
    const output =
      writer === 'files'
        ? await createPackage(source, archive)
        : await createPackageFromStreams(archive, [
            {
              path: 'payload.bin',
              type: 'file',
              unpacked: false,
              stat: await stat(input),
              streamGenerator: () => Readable.from([content]),
            },
          ]);
    // electron-builder awaits this promise without awaiting the returned stream.
    assert.ok(output instanceof Writable);
    assert.equal(output.writableFinished, true);
    assert.deepEqual(extractFile(archive, 'payload.bin'), content);
  });
}
