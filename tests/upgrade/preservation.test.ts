import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Library } from '../../src/main/storage/library';
import type { GenerationWorkspace } from '../../src/shared/generation/workspace';
import type { ProjectSnapshot } from '../../src/shared/models';
import { assertIntegrity, assertQueue, assertWorkspace } from './checks';
import { assertOriginalFiles, baselines, history, runNode } from './history';
import { withMovementDefaults } from './interaction-settings-expectations';

for (const baseline of baselines) {
  test(`${baseline.name}: old writer -> new reader/editor -> two process restarts preserves data`, async (t) => {
    const f = await history(t, baseline);
    const { expected } = f;
    const [original, independent] = expected.projects;
    assert.ok(original && independent);
    const library = await Library.open(f.app, f.defaultRoot);
    let wantedWorkspace: GenerationWorkspace;
    let wantedProject: ProjectSnapshot;
    const wantedSettings = withMovementDefaults({
      ...expected.settings,
      shortcuts: {
        ...expected.settings.shortcuts,
        locateLabels: Object.hasOwn(expected.settings.shortcuts, 'locateLabels')
          ? expected.settings.shortcuts.locateLabels
          : { key: 'l', mod: false, shift: false, alt: false },
      },
    });
    const wantedDraft = {
      ...expected.draft,
      prompt: `${expected.draft.prompt}\n新版追加，原内容保留`,
      revision: expected.draft.revision + 1,
    };
    try {
      await library.saves.idle();
      assert.equal(library.state().root, expected.root);
      assert.deepEqual(
        library
          .state()
          .projects.map((project) => project.id)
          .sort(),
        [
          ...expected.projects.map((project) => project.project.id),
          expected.pendingProject.id,
        ].sort(),
      );
      assert.deepEqual(
        await library.projects.open(original.project.id),
        original,
      );
      assert.deepEqual(
        await library.projects.open(independent.project.id),
        independent,
      );
      assert.deepEqual(library.interactions.get(), wantedSettings);
      assert.deepEqual(
        await library.generation.read(original.project.id),
        expected.draft,
      );
      const workspace = await library.generation.readWorkspace(
        original.project.id,
      );
      assertWorkspace(expected, workspace);
      await assertOriginalFiles(expected);
      await assertQueue(library, expected);

      // Exercise current write paths, not just a SELECT against an old file.
      wantedWorkspace = structuredClone(workspace);
      const text = wantedWorkspace.shots[0]?.nodes.find(
        (node) => node.type === 'text',
      );
      assert.ok(text?.type === 'text');
      text.text += '\n新版编辑';
      await library.generation.saveWorkspace(
        original.project.id,
        wantedWorkspace,
      );
      wantedWorkspace.revision++;
      await library.generation.save(original.project.id, {
        ...wantedDraft,
        revision: expected.draft.revision,
      });
      const cards = structuredClone(original.canvas.cards);
      const card = cards[0];
      assert.ok(card);
      card.position.x += 25;
      await library.projects.patchCanvas(original.project.id, {
        before: original.canvas.cards,
        after: cards,
      });
      const name = `${original.project.name}（升级后编辑）`;
      await library.projects.update(original.project.id, { name });
      wantedProject = {
        ...original,
        project: { ...original.project, name },
        canvas: {
          ...original.canvas,
          revision: original.canvas.revision + 1,
          cards,
        },
      };
      library.interactions.save(wantedSettings);
    } finally {
      await library.close();
    }
    const contractFile = join(f.data, 'after-edit.json');
    await writeFile(
      contractFile,
      JSON.stringify({
        expected,
        wantedProject,
        wantedWorkspace,
        wantedDraft,
        wantedSettings,
      }),
    );
    for (let restart = 1; restart <= 2; restart++)
      await runNode(new URL('./reopen.ts', import.meta.url), [
        f.app,
        f.defaultRoot,
        contractFile,
      ]);
    await assert.rejects(access(f.defaultRoot), { code: 'ENOENT' });
    assertIntegrity(join(f.app, 'app.sqlite'));
    for (const project of [
      ...expected.projects.map((entry) => entry.project),
      expected.pendingProject,
    ])
      assertIntegrity(join(expected.root, project.folder, 'project.sqlite'));
    t.diagnostic(
      'Verified identities, separate projects, settings, canvas order/trims, text/references/parameters, pending saves, source hashes and database integrity.',
    );
  });
}
