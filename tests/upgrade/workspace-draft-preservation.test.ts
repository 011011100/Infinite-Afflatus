import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Library } from '../../src/main/storage/library';
import { workspaceDraftState } from '../../src/shared/workspace-draft';
import {
  assertIntegrity,
  assertQueue,
  assertWorkspace,
  withoutTimestamp,
} from './checks';
import {
  assertOriginalFiles,
  type Baseline,
  fileHash,
  history,
  runNode,
} from './history';
import { withMovementDefaults } from './interaction-settings-expectations';
import type {
  HistoricalWorkspaceDraft,
  WorkspaceDraftContract,
} from './reopen-workspace-draft';

const baseline: Baseline & { formatVersion: number } = JSON.parse(
  await readFile(
    new URL('./workspace-draft-baseline.json', import.meta.url),
    'utf8',
  ),
);
assert.equal(baseline.scenario, 'image-workspace');
assert.equal(baseline.formatVersion, 1);
assert.match(
  baseline.commit,
  /^[a-f0-9]{40}$/,
  'A fixed workspace draft writer commit is required; never use HEAD or the working tree',
);

for (const mode of ['unsubmitted', 'last-submitted'] as const) {
  test(`${baseline.name}/${mode}: historical recovery record -> current restore -> two process restarts preserves content and media`, async (t) => {
    const f = await history(t, baseline);
    await runNode(new URL('./seed-workspace-draft.mjs', import.meta.url), [
      join(f.base, 'old-code'),
      f.data,
      baseline.commit,
      mode,
    ]);
    const draft: HistoricalWorkspaceDraft = JSON.parse(
      await readFile(join(f.data, 'workspace-draft-expected.json'), 'utf8'),
    );
    assert.equal(draft.writerCommit, baseline.commit);
    assert.equal(draft.formatVersion, baseline.formatVersion);
    assert.equal(draft.mode, mode);
    assert.equal(await fileHash(draft.file), draft.fileSha256);
    const { record } = draft;
    const [original, independent] = f.expected.projects;
    assert.ok(original && independent && f.expected.workspace);
    assert.equal(record.format, 'infinite-afflatus-workspace-draft');
    assert.equal(record.version, 1);
    assert.equal(record.saved, false);
    assert.equal(record.seq, mode === 'last-submitted' ? 2 : 1);
    assert.deepEqual(record.baseline, f.expected.workspace);
    assertWorkspace(f.expected, record.baseline);
    assert.equal(
      Object.hasOwn(record, 'lastSubmitted'),
      mode === 'last-submitted',
    );
    assert.deepEqual(
      draft.diskWorkspace,
      mode === 'last-submitted' ? record.lastSubmitted : record.baseline,
    );
    assert.equal(
      workspaceDraftState(record, draft.diskWorkspace),
      mode === 'last-submitted' ? 'matching-submission' : 'matching',
    );
    // Preserve the authored historical contract. Do not make a current service's
    // response the expected value: it could already have dropped a field.
    const wantedWorkspace = structuredClone(record.workspace);
    wantedWorkspace.revision =
      f.expected.workspace.revision + (mode === 'last-submitted' ? 2 : 1);
    assert.equal(wantedWorkspace.shots.length, 2);
    assert.equal(wantedWorkspace.shots[0]?.groups.length, 4);
    assert.equal(wantedWorkspace.shots[1]?.groups.length, 1);
    assert.deepEqual(
      [...new Set(original.assets.map((asset) => asset.kind))].sort(),
      ['audio', 'image', 'text', 'video'],
    );
    const library = await Library.open(f.app, f.defaultRoot);
    try {
      await library.saves.idle();
      assert.equal(library.state().root, f.expected.root);
      assert.deepEqual(await library.drafts.list(original.project.id), {
        drafts: [record],
        issues: [],
      });
      assert.equal(
        await fileHash(draft.file),
        draft.fileSha256,
        'Opening and listing must not rewrite the historical recovery record',
      );
      assert.deepEqual(
        await library.generation.readWorkspace(original.project.id),
        draft.diskWorkspace,
      );
      let restores = 0;
      const restored = await library.drafts.recover(
        original.project,
        { sessionId: record.sessionId, seq: record.seq },
        () => library.generation.readWorkspace(original.project.id),
        (confirmed, workspace) => {
          restores++;
          assert.deepEqual(confirmed, draft.diskWorkspace);
          return library.generation.saveWorkspace(
            original.project.id,
            workspace,
            confirmed,
          );
        },
      );
      assert.equal(
        restores,
        1,
        'Recovery must save the unfinished workspace exactly once',
      );
      assert.deepEqual(restored, wantedWorkspace);
      assert.deepEqual(
        await library.generation.readWorkspace(original.project.id),
        wantedWorkspace,
      );
      assert.deepEqual(
        withoutTimestamp(await library.projects.open(original.project.id)),
        withoutTimestamp(original),
      );
      assert.deepEqual(
        await library.projects.open(independent.project.id),
        independent,
      );
      assert.deepEqual(
        await library.generation.read(original.project.id),
        f.expected.draft,
      );
      assert.deepEqual(
        library.interactions.get(),
        withMovementDefaults(f.expected.settings),
      );
      assert.deepEqual(await library.drafts.list(original.project.id), {
        drafts: [],
        issues: [],
      });
      await assert.rejects(access(draft.file), { code: 'ENOENT' });
      assert.equal(
        await readFile(draft.unrelatedFile, 'utf8'),
        draft.unrelatedContent,
      );
      assert.equal(
        await fileHash(draft.independentFile),
        draft.independentSha256,
      );
      await assertQueue(library, f.expected);
      await assertOriginalFiles(f.expected);
    } finally {
      await library.close();
    }

    const contract: WorkspaceDraftContract = {
      app: f.app,
      defaultRoot: f.defaultRoot,
      expected: f.expected,
      draft,
      wantedWorkspace,
    };
    const contractFile = join(f.data, 'workspace-draft-after-restore.json');
    await writeFile(contractFile, JSON.stringify(contract));
    for (let restart = 0; restart < 2; restart++)
      await runNode(new URL('./reopen-workspace-draft.ts', import.meta.url), [
        contractFile,
      ]);
    await assert.rejects(access(f.defaultRoot), { code: 'ENOENT' });
    await assertOriginalFiles(f.expected);
    assert.equal(
      await fileHash(draft.independentFile),
      draft.independentSha256,
    );
    assertIntegrity(join(f.app, 'app.sqlite'));
    for (const project of [
      ...f.expected.projects.map((entry) => entry.project),
      f.expected.pendingProject,
    ])
      assertIntegrity(join(f.expected.root, project.folder, 'project.sqlite'));
    t.diagnostic(
      `Verified draft format ${baseline.formatVersion} from fixed writer ${baseline.commit} (${mode}): text/order/overrides, video/image parameters, groups/references/labels/viewports, source hashes, independent project, settings/queue, exact acknowledgement cleanup and two independent restarts.`,
    );
  });
}
