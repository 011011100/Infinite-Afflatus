import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectEditDraftState } from '../../src/shared/project-edit-draft';
import { workspaceDraftState } from '../../src/shared/workspace-draft';
import { withoutTimestamp } from './checks';
import { type Baseline, fileHash, history, runNode } from './history';
import {
  assertRescuePreserved,
  type HistoricalRescue,
  isWorkspace,
  openRescueServices,
  type RescueUpgradeContract,
} from './rescue-contract';

const baselines: Baseline[] = JSON.parse(
  await readFile(new URL('./rescue-baselines.json', import.meta.url), 'utf8'),
);
const cases = [
  ['workspace-input', 'matching'],
  ['workspace-last-submitted', 'matching-submission'],
  ['workspace-submitted', 'submitted'],
  ['name-last-submitted', 'matching-submission'],
  ['name-blank', 'matching'],
  ['trim-input', 'matching'],
  ['trim-last-submitted', 'matching-submission'],
  ['trim-conflict', 'conflict'],
] as const;
for (const [mode, state] of cases)
  test(`fixed historical rescue export → current explicit recovery: ${mode}`, async (t) => {
    const baseline = baselines.find(
      (item) =>
        item.name ===
        (mode.startsWith('workspace')
          ? 'workspace-rescue-v1'
          : 'project-edit-rescue-v1'),
    );
    assert.ok(baseline);
    assert.equal(
      baseline.commit,
      mode.startsWith('workspace')
        ? '29f19980b993a4462d3c97605ea55be51806a037'
        : '1f77f143f909940571a337adcc787b301933bd86',
    );
    const fixture = await history(t, baseline);
    await runNode(new URL('./seed-rescue-export.mjs', import.meta.url), [
      join(fixture.base, 'old-code'),
      fixture.data,
      baseline.commit,
      mode,
    ]);
    const old: HistoricalRescue = JSON.parse(
      await readFile(join(fixture.data, 'rescue-expected.json'), 'utf8'),
    );
    assert.equal(old.writerCommit, baseline.commit);
    assert.equal(old.mode, mode);
    const record = old.record;
    assert.equal(
      isWorkspace(record)
        ? workspaceDraftState(record, old.workspace)
        : projectEditDraftState(record, old.disk),
      state,
    );
    const wanted = structuredClone(old.disk);
    let wantedWorkspace = structuredClone(old.workspace);
    const blocked = mode === 'trim-conflict' || mode === 'name-blank';
    if (!blocked) {
      if (isWorkspace(record))
        wantedWorkspace = {
          ...structuredClone(record.workspace),
          revision: old.workspace.revision + (state === 'submitted' ? 0 : 1),
        };
      else if (record.kind === 'name')
        wanted.project.name = record.target.trim();
      else {
        wanted.canvas.revision++;
        wanted.canvas.cards = wanted.canvas.cards.map((card) =>
          card.id === record.target.id ? structuredClone(record.target) : card,
        );
      }
    }
    const services = openRescueServices(fixture.app, fixture.defaultRoot);
    let contract: RescueUpgradeContract;
    try {
      const before = await fileHash(fixture.projectFile);
      const preview = await services.imports.prepare(old.exportPath, 17);
      assert.equal(preview.state, state);
      assert.equal(
        preview.kind,
        isWorkspace(record) ? 'workspace' : record.kind,
      );
      assert.equal(preview.updatedAt, record.updatedAt);
      assert.equal(
        await fileHash(fixture.projectFile),
        before,
        'Preview cannot write the project',
      );
      const imported = await services.imports.confirm(preview.token, 17);
      assert.equal(imported.duplicate, false);
      assert.equal(imported.projectId, record.project.id);
      assert.match(imported.key.sessionId, /^rescue-/);
      assert.notEqual(imported.key.sessionId, record.sessionId);
      assert.equal(imported.key.seq, 1);
      assert.equal(
        await fileHash(fixture.projectFile),
        before,
        'Import only adds a draft; it must not apply it',
      );
      const current = isWorkspace(record)
        ? await services.drafts.get(record.project.id, imported.key)
        : await services.edits.get(record.project.id, imported.key);
      assert.deepEqual(current, {
        ...record,
        sessionId: imported.key.sessionId,
        seq: 1,
      });
      // Importing the same unchanged external file twice must not create an
      // unbounded stream of identical recovery copies or replace the old stream.
      const again = await services.imports.prepare(old.exportPath, 17);
      const duplicate = await services.imports.confirm(again.token, 17);
      assert.deepEqual(duplicate, { ...imported, duplicate: true });
      const recover = () =>
        isWorkspace(record)
          ? services.drafts.recover(
              services.projects.summary(record.project.id),
              imported.key,
              () => services.generation.readWorkspace(record.project.id),
              (base, workspace) =>
                services.generation.saveWorkspace(
                  record.project.id,
                  workspace,
                  base,
                ),
            )
          : services.edits.recover(
              services.projects.summary(record.project.id),
              imported.key,
              (value, verify) =>
                services.projects.restoreProjectEdit(
                  record.project.id,
                  value,
                  verify,
                ),
            );
      if (blocked) {
        await assert.rejects(
          recover,
          mode === 'name-blank' ? /名称/ : /基线|变化|不同/,
        );
        assert.equal(
          await fileHash(fixture.projectFile),
          before,
          'A conflict or blank name cannot alter project bytes',
        );
        const exported = join(
          fixture.data,
          '仍可导出的副本.afflatus-edit-draft.json',
        );
        await services.edits.export(
          services.projects.summary(record.project.id),
          imported.key,
          exported,
        );
        assert.deepEqual(
          JSON.parse(await readFile(exported, 'utf8')).draft,
          current,
        );
      } else {
        const recovered = await recover();
        if (isWorkspace(record)) assert.deepEqual(recovered, wantedWorkspace);
        else
          assert.deepEqual(
            withoutTimestamp(recovered as typeof wanted),
            withoutTimestamp(wanted),
          );
        if (state === 'submitted')
          assert.equal(
            await fileHash(fixture.projectFile),
            before,
            'Already-saved target only acknowledges the imported copy',
          );
      }
      contract = {
        app: fixture.app,
        defaultRoot: fixture.defaultRoot,
        expected: fixture.expected,
        history: old,
        wanted,
        wantedWorkspace,
        imported,
        retainedImport: blocked ? current : null,
      };
      await assertRescuePreserved(contract, services);
    } finally {
      await services.close();
    }
    const contractFile = join(fixture.data, 'rescue-current-contract.json');
    await writeFile(contractFile, JSON.stringify(contract, null, 2));
    for (let restart = 1; restart <= 2; restart++) {
      const reopened = await runNode(
        new URL('./reopen-rescue-import.ts', import.meta.url),
        [contractFile],
      );
      assert.match(reopened.stdout, /Rescue import independently reopened/);
    }
  });
