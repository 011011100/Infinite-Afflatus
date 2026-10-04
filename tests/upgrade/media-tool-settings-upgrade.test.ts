import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { AppStore } from '../../src/main/storage/app-store';
import { type Baseline, fileHash, history, runNode } from './history';
import {
  assertMediaToolPreservation,
  assertSettingsRead,
  type MediaToolUpgradeContract,
  rawMediaToolSetting,
  settingsService,
} from './media-tool-settings-contract';

// The historical writer must be a fixed commit; never substitute HEAD or current code.
const mediaCommit = '309d0b7e517ae619575d291e9702ac904d08a941';
const baseline: Baseline = JSON.parse(
  await readFile(
    new URL('./media-tool-settings-baseline.json', import.meta.url),
    'utf8',
  ),
);
assert.equal(baseline.commit, mediaCommit);
const legacy: Baseline = {
  name: 'media-tool-settings-absent',
  scenario: 'image-workspace',
  commit: 'b477334c44f76fba6cf0fb607bcc7268c67e00cf',
  description:
    'Last explicit legacy baseline without persisted media-tool settings',
};

async function fixture(
  t: TestContext,
  historical: Baseline,
  mode: 'absent' | 'configured',
) {
  const f = await history(t, historical);
  await runNode(new URL('./seed-media-tool-settings.mjs', import.meta.url), [
    join(f.base, 'old-code'),
    f.data,
    historical.commit,
    mode,
  ]);
  const contract: MediaToolUpgradeContract = JSON.parse(
    await readFile(join(f.data, 'media-tool-settings-expected.json'), 'utf8'),
  );
  assert.equal(contract.writerCommit, historical.commit);
  assert.deepEqual(contract.expected, f.expected);
  assert.equal(contract.expected.queued.status, 'ready');
  if (mode === 'configured') {
    assert.ok(contract.paths?.ffmpeg && contract.paths.ffprobe);
    assert.notEqual(contract.paths.ffmpeg, contract.paths.ffprobe);
    assert.ok(contract.paths.ffmpeg.includes('组件 路径'));
    assert.ok(contract.paths.ffprobe.includes('组件 路径'));
    assert.deepEqual(
      contract.inspections,
      ['ffmpeg', 'ffprobe'].map((name) => ({
        name,
        command: contract.paths?.[name as 'ffmpeg' | 'ffprobe'],
      })),
    );
    assert.deepEqual(JSON.parse(contract.raw ?? ''), {
      version: 1,
      ...contract.paths,
    });
  } else {
    assert.equal(contract.raw, null);
    assert.deepEqual(contract.inspections, []);
  }
  return { ...f, contract };
}

async function reopenTwice(
  data: string,
  contract: MediaToolUpgradeContract,
  label: string,
) {
  const file = join(data, `media-tool-settings-${label}.json`);
  await writeFile(file, JSON.stringify(contract), { flag: 'wx' });
  for (let restart = 0; restart < 2; restart++)
    await runNode(new URL('./reopen-media-tool-settings.ts', import.meta.url), [
      file,
    ]);
}

test('legacy b477334 without media-tool settings remains unwritten across current reads and two independent process restarts', async (t) => {
  const f = await fixture(t, legacy, 'absent');
  const before = await fileHash(join(f.app, 'app.sqlite'));
  await reopenTwice(f.data, f.contract, 'absent');
  assert.equal(rawMediaToolSetting(f.app), null);
  assert.equal(await fileHash(join(f.app, 'app.sqlite')), before);
  t.diagnostic(
    `Archived ${legacy.commit}: no settings row added; project databases, seven original assets, interaction settings and protected ready job unchanged. Injected version inspector; no media executable was run.`,
  );
});

test('fixed v1 public choose paths survive upgrade; resetting one path retains the other across two process restarts', async (t) => {
  const f = await fixture(t, baseline, 'configured');
  const store = new AppStore(join(f.app, 'app.sqlite'), f.defaultRoot);
  const { service } = settingsService(store);
  try {
    await assertSettingsRead(f.contract, store);
    await assertMediaToolPreservation(f.contract, store);
    const wanted = { ffmpeg: null, ffprobe: f.contract.paths?.ffprobe ?? null };
    assert.ok(wanted.ffprobe);
    const result = await service.reset('ffmpeg', () => {});
    assert.deepEqual(result.settings.paths, wanted);
    f.contract.paths = wanted;
    f.contract.raw = JSON.stringify({ version: 1, ...wanted });
    await assertMediaToolPreservation(f.contract, store);
  } finally {
    await service.close();
    store.close();
  }
  await reopenTwice(f.data, f.contract, 'one-reset');
  t.diagnostic(
    `Archived ${baseline.commit} public choose wrote both v1 paths; a current single reset preserved the independent other path and every existing project, file and queued result. Storage-only inspector, not a media run.`,
  );
});

for (const mode of ['invalid-fields', 'future-version'] as const) {
  test(`fixed v1 ${mode}: incompatible JSON is preserved across two restarts and only explicit clear-all repairs the paths`, async (t) => {
    const f = await fixture(t, baseline, 'configured');
    // These are deliberate damage/future-format injections after a genuine old
    // public choose. Invalid JSON syntax instead belongs to startup fail-closed.
    const damaged =
      mode === 'invalid-fields'
        ? { version: 1, ffmpeg: 42, ffprobe: f.contract.paths?.ffprobe }
        : {
            version: 99,
            ...f.contract.paths,
            futureOption: { preserve: '不能丢弃' },
          };
    const store = new AppStore(join(f.app, 'app.sqlite'), f.defaultRoot);
    try {
      store.set('mediaToolSettings', damaged);
    } finally {
      store.close();
    }
    f.contract.raw = JSON.stringify(damaged);
    f.contract.paths = null;
    const before = await fileHash(join(f.app, 'app.sqlite'));
    await reopenTwice(f.data, f.contract, mode);
    assert.equal(await fileHash(join(f.app, 'app.sqlite')), before);
    const reopened = new AppStore(join(f.app, 'app.sqlite'), f.defaultRoot);
    const { service } = settingsService(reopened);
    try {
      await assertSettingsRead(f.contract, reopened);
      const result = await service.reset('all', () => {});
      const wanted = { ffmpeg: null, ffprobe: null };
      assert.deepEqual(result.settings.paths, wanted);
      f.contract.paths = wanted;
      f.contract.raw = JSON.stringify({ version: 1, ...wanted });
      await assertMediaToolPreservation(f.contract, reopened);
    } finally {
      await service.close();
      reopened.close();
    }
    await reopenTwice(f.data, f.contract, `${mode}-repaired`);
  });
}
