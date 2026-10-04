import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectEditDraftState } from '../../src/shared/project-edit-draft';
import { assertIntegrity, withoutTimestamp } from './checks';
import { type Baseline, fileHash, history, runNode } from './history';
import {
  assertProjectEditPreserved,
  type HistoricalProjectEditDraft,
  openProjectEditServices,
  type ProjectEditUpgradeContract,
} from './project-edit-draft-contract';

const baseline: Baseline & { formatVersion: number } = JSON.parse(
  await readFile(
    new URL('./project-edit-draft-baseline.json', import.meta.url),
    'utf8',
  ),
);
assert.equal(baseline.scenario, 'image-workspace');
assert.equal(baseline.formatVersion, 1);
assert.match(
  baseline.commit,
  /^[a-f0-9]{40}$/,
  'Project edit history requires a fixed native writer commit; never HEAD or working-tree code',
);

for (const mode of [
  'name-input',
  'name-last-submitted',
  'trim-input',
  'trim-last-submitted',
] as const) {
  test(`${baseline.name}/${mode}: fixed historical public writer -> current explicit restore -> two isolated restarts`, async (t) => {
    const f = await history(t, baseline);
    await runNode(new URL('./seed-project-edit-draft.mjs', import.meta.url), [
      join(f.base, 'old-code'),
      f.data,
      baseline.commit,
      mode,
    ]);
    const historical: HistoricalProjectEditDraft = JSON.parse(
      await readFile(join(f.data, 'project-edit-draft-expected.json'), 'utf8'),
    );
    assert.equal(historical.writerCommit, baseline.commit);
    assert.equal(historical.formatVersion, baseline.formatVersion);
    assert.equal(historical.mode, mode);
    const { record, input } = historical;
    const [original] = f.expected.projects;
    assert.ok(original);
    assert.equal(record.format, 'infinite-afflatus-project-edit-draft');
    assert.equal(record.version, 1);
    assert.equal(record.seq, mode.endsWith('last-submitted') ? 2 : 1);
    assert.equal(record.kind, mode.startsWith('name') ? 'name' : 'trim');
    assert.equal(
      Object.hasOwn(record, 'lastSubmitted'),
      mode.endsWith('last-submitted'),
    );
    assert.equal(
      projectEditDraftState(record, historical.disk),
      mode.endsWith('last-submitted') ? 'matching-submission' : 'matching',
    );
    assert.equal(await fileHash(historical.file), historical.fileSha256);
    // Expectations are authored before current recovery, never copied from its
    // result. The old writer already verifies every field of the protected input.
    const wanted = structuredClone(original);
    if (input.kind === 'name') {
      assert.equal(input.baseline, original.project.name);
      assert.equal(input.target, '  尚未确认的 中文名称 B 🎬  ');
      wanted.project.name = input.target.trim();
    } else {
      assert.deepEqual(input.baseline, original.canvas.cards[0]);
      assert.deepEqual(
        input.assets,
        input.baseline.assetIds.map((id) =>
          original.assets.find((asset) => asset.id === id),
        ),
      );
      assert.equal(input.assets.length, 3);
      assert.deepEqual(input.target.assetIds, input.baseline.assetIds);
      assert.deepEqual(input.target.position, input.baseline.position);
      assert.deepEqual(input.target.trims?.[input.baseline.assetIds[0] ?? ''], {
        start: 5.125,
        end: 10.75,
      });
      assert.deepEqual(input.target.trims?.[input.baseline.assetIds[1] ?? ''], {
        start: 2.25,
        end: 8.5,
      });
      wanted.canvas = {
        ...wanted.canvas,
        revision:
          wanted.canvas.revision + (mode.endsWith('last-submitted') ? 2 : 1),
        cards: [
          ...wanted.canvas.cards.filter((card) => card.id !== input.target.id),
          structuredClone(input.target),
        ],
      };
    }
    const contract: ProjectEditUpgradeContract = {
      app: f.app,
      defaultRoot: f.defaultRoot,
      expected: f.expected,
      history: historical,
      wanted,
    };
    const services = openProjectEditServices(f.app, f.defaultRoot);
    try {
      const list = await services.drafts.list(original.project.id);
      assert.deepEqual(list.drafts, [record]);
      assert.equal(list.issues.length, 2);
      assert.equal(
        await fileHash(historical.file),
        historical.fileSha256,
        'Opening/listing historical editor records is read-only',
      );
      assert.deepEqual(
        await services.projects.open(original.project.id),
        historical.disk,
      );
      await assert.rejects(
        services.drafts.discard(original.project.id, {
          sessionId: 'future',
          seq: 1,
        }),
        /版本不受支持/,
      );
      await assert.rejects(
        services.drafts.discard(original.project.id, {
          sessionId: 'broken',
          seq: 1,
        }),
        /JSON/,
      );
      const restored = await services.drafts.recover(
        services.projects.summary(original.project.id),
        record,
        (draft, verify) =>
          services.projects.restoreProjectEdit(
            original.project.id,
            draft,
            verify,
          ),
      );
      assert.deepEqual(withoutTimestamp(restored), withoutTimestamp(wanted));
      await assertProjectEditPreserved(contract, services);
    } finally {
      await services.close();
    }
    const contractFile = join(f.data, 'project-edit-after-restore.json');
    await writeFile(contractFile, JSON.stringify(contract));
    for (let restart = 0; restart < 2; restart++)
      await runNode(
        new URL('./reopen-project-edit-draft.ts', import.meta.url),
        [contractFile],
      );
    assertIntegrity(join(f.app, 'app.sqlite'));
    for (const project of [
      ...f.expected.projects.map((entry) => entry.project),
      f.expected.pendingProject,
    ])
      assertIntegrity(join(f.expected.root, project.folder, 'project.sqlite'));
    t.diagnostic(
      `Fixed native writer ${baseline.commit}; ${mode}; exact name/card/asset metadata, original workspace bytes, independent project, untouched ready queue and settings, unsupported records retained, exact acknowledgement cleanup, two fresh-process reopens.`,
    );
  });
}
