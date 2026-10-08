import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceDraftQueue } from '../src/renderer/src/features/drafts/workspace-draft-queue';
import {
  type ArkAdoptionBaseline,
  arkAdoptionDidNotCommit,
  requestArkAdoption,
  validateArkAdoption,
} from '../src/renderer/src/features/generation/ark-adoption';
import { MainCanvasHistory } from '../src/shared/canvas/main-history';
import type {
  ArkAdoptionResult,
  ArkGenerationJob,
} from '../src/shared/generation/ark-types';
import { ShotHistory } from '../src/shared/generation/shot-history';
import { newShot } from '../src/shared/generation/workspace';
import type { Asset } from '../src/shared/models';
import {
  type WorkspaceDraftInput,
  workspaceDraftState,
} from '../src/shared/workspace-draft';

const asset = (id: string, kind: Asset['kind'] = 'video'): Asset => ({
  id,
  kind,
  name: `${id}.media`,
  relativePath: `assets/${id}.media`,
  size: 100,
  sha256: 'a'.repeat(64),
});
function fixture(kind: 'image' | 'video' = 'image') {
  const source = newShot('source', 'Source', { x: 10, y: 20 });
  source.nodes.push({
    id: 'text',
    type: 'text',
    text: 'Keep this edit',
    position: { x: 30, y: 40 },
  });
  const baseline: ArkAdoptionBaseline = {
    jobId: 'job',
    workspace: {
      version: 1,
      revision: 8,
      shots: [source, newShot('other', 'Other', { x: 90, y: 100 })],
    },
    project: {
      project: {
        id: 'project',
        folder: 'project-folder',
        name: 'Project',
        updatedAt: '',
      },
      viewport: { x: 25, y: 35, zoom: 0.7 },
      assets: [
        asset('a'),
        asset('b'),
        { ...asset('candidate', kind), usage: 'reference' },
      ],
      canvas: {
        version: 1,
        revision: 3,
        cards: [
          {
            id: 'combo',
            position: { x: 5, y: 6 },
            assetIds: ['a', 'b'],
            trims: { a: { start: 1, end: 4 } },
          },
        ],
      },
    },
  };
  const result: ArkAdoptionResult = {
    jobId: 'job',
    assetId: 'candidate',
    sourceShotId: 'source',
    shotId: kind === 'image' ? 'source' : 'copy',
    kind,
    baselineRevision: 8,
    committedRevision: 9,
    workspace: structuredClone(baseline.workspace),
    snapshot: structuredClone(baseline.project),
  };
  result.workspace.revision++;
  if (kind === 'image')
    result.workspace.shots[0]?.nodes.push({
      id: 'generated',
      type: 'asset',
      assetId: 'candidate',
      position: { x: 80, y: 200 },
    });
  else {
    result.workspace.shots.push({
      ...newShot('copy', 'Generated', { x: 100, y: 300 }),
      sourceAssetId: 'candidate',
    });
    delete result.snapshot.assets[2]?.usage;
    result.snapshot.canvas.cards.push({
      id: 'new-card',
      assetIds: ['candidate'],
      position: { x: 100, y: 300 },
    });
    result.snapshot.canvas.revision++;
  }
  return { baseline, result };
}

test('image adoption preserves source selection/context and adds one isolated content undo step', () => {
  const { baseline, result } = fixture();
  const history = new ShotHistory();
  const source = baseline.workspace.shots[0];
  const after = result.workspace.shots[0];
  assert.ok(source && after);
  history.record({ ...source, name: 'Earlier source' }, source);
  validateArkAdoption(baseline, result);
  history.record(source, after);
  const undo = history.undo(after);
  assert.deepEqual(undo, source);
  assert.equal(history.undo(undo).name, 'Earlier source');
  assert.deepEqual(result.snapshot.canvas, baseline.project.canvas);
});

test('video adoption accepts an independent appended card and leaves existing unified history untouched', () => {
  const { baseline, result } = fixture('video');
  const history = new MainCanvasHistory();
  const source = baseline.workspace.shots[0];
  assert.ok(source);
  const op = {
    kind: 'shot' as const,
    operation: { type: 'remove' as const, id: source.id },
  };
  history.begin(op)?.commit({
    kind: 'shot',
    operation: { type: 'insert', shot: source, index: 0 },
  });
  const before = history.getSnapshot();
  validateArkAdoption(baseline, result);
  assert.strictEqual(history.getSnapshot(), before);
  assert.deepEqual(
    result.workspace.shots.slice(0, -1),
    baseline.workspace.shots,
  );
  assert.deepEqual(
    result.snapshot.canvas.cards.slice(0, -1),
    baseline.project.canvas.cards,
  );
});

test('receipts cannot replace another project, job, saved baseline, or newer dirty workspace', () => {
  const { baseline, result } = fixture();
  for (const change of [
    (value: ArkAdoptionResult) => {
      value.jobId = 'other-job';
    },
    (value: ArkAdoptionResult) => {
      value.snapshot.project.id = 'other-project';
    },
    (value: ArkAdoptionResult) => {
      value.snapshot.project.folder = 'other-folder';
    },
    (value: ArkAdoptionResult) => {
      value.sourceShotId = 'other';
    },
    (value: ArkAdoptionResult) => {
      value.baselineRevision++;
    },
    (value: ArkAdoptionResult) => {
      value.workspace.revision++;
    },
    (value: ArkAdoptionResult) => {
      const shot = value.workspace.shots[1];
      if (shot) shot.name = 'External change';
    },
  ]) {
    const changed = structuredClone(result);
    change(changed);
    assert.throws(() => validateArkAdoption(baseline, changed));
  }
  const dirty = structuredClone(baseline);
  const source = dirty.workspace.shots[0];
  assert.ok(source);
  source.name = 'Newer local input';
  assert.throws(() => validateArkAdoption(dirty, result));
});

test('changed combinations, trims, old assets, or unrelated imported cards are never silently accepted', () => {
  const { baseline, result } = fixture('video');
  for (const change of [
    (value: ArkAdoptionResult) => {
      value.snapshot.canvas.cards[0]?.assetIds.reverse();
    },
    (value: ArkAdoptionResult) => {
      const trim = value.snapshot.canvas.cards[0]?.trims?.a;
      if (trim) trim.end = 5;
    },
    (value: ArkAdoptionResult) => {
      const card = value.snapshot.canvas.cards[0];
      if (card) card.position.x++;
    },
    (value: ArkAdoptionResult) => {
      const old = value.snapshot.assets[0];
      if (old) old.sha256 = 'b'.repeat(64);
    },
    (value: ArkAdoptionResult) => {
      value.snapshot.canvas.cards.push({
        id: 'unexpected',
        assetIds: ['unknown'],
        position: { x: 0, y: 0 },
      });
    },
  ]) {
    const changed = structuredClone(result);
    change(changed);
    assert.throws(() => validateArkAdoption(baseline, changed));
  }
});

test('lost adoption reply retries the same job and original CAS revision only once', async () => {
  const { baseline, result } = fixture();
  const calls: [string, number][] = [];
  let committed = false;
  const saved = await requestArkAdoption(
    {
      adoptArkJob: async (jobId, revision) => {
        calls.push([jobId, revision]);
        if (!committed) {
          committed = true;
          throw new Error('reply lost');
        }
        return result;
      },
    },
    baseline,
  );
  assert.strictEqual(saved, result);
  assert.deepEqual(calls, [
    ['job', 8],
    ['job', 8],
  ]);
  assert.equal(saved.workspace.shots[0]?.nodes.length, 2);
});

test('a current snapshot returned with an old receipt cannot overwrite later remote edits', async () => {
  const { baseline, result } = fixture();
  result.workspace.revision++;
  let calls = 0;
  await assert.rejects(
    requestArkAdoption(
      {
        adoptArkJob: async () => {
          calls++;
          return result;
        },
      },
      baseline,
    ),
  );
  assert.equal(
    calls,
    1,
    'a mismatching receipt is not a failed transport call',
  );
});

test('unlock after failure requires both an unadopted job and exact unchanged disk workspace', async () => {
  const { baseline, result } = fixture();
  const candidate = { id: 'job', phase: 'candidate' } as ArkGenerationJob;
  const bridge = {
    listArkJobs: async () => [candidate],
    getGenerationWorkspace: async () => baseline.workspace,
  };
  assert.equal(await arkAdoptionDidNotCommit(bridge, baseline), true);
  assert.equal(
    await arkAdoptionDidNotCommit(
      { ...bridge, getGenerationWorkspace: async () => result.workspace },
      baseline,
    ),
    false,
  );
  assert.equal(
    await arkAdoptionDidNotCommit(
      {
        ...bridge,
        listArkJobs: async () => [{ ...candidate, phase: 'adopted' }],
      },
      baseline,
    ),
    false,
  );
  assert.equal(
    await arkAdoptionDidNotCommit(
      { ...bridge, listArkJobs: async () => [] },
      baseline,
    ),
    false,
  );
  assert.equal(
    await arkAdoptionDidNotCommit(
      {
        ...bridge,
        getGenerationWorkspace: async () => {
          throw new Error('offline');
        },
      },
      baseline,
    ),
    false,
  );
});

test('adoption advances independent draft baseline and old acknowledgements cannot revive its prior input', async () => {
  const { baseline, result } = fixture();
  let stored: WorkspaceDraftInput | null = null;
  let watermark = 0;
  const queue = new WorkspaceDraftQueue('project', 'session', {
    protectWorkspaceDraft: async (_id, value) => {
      if (value.seq <= watermark) return watermark;
      if (!stored || value.seq >= stored.seq) stored = structuredClone(value);
      return value.seq;
    },
    acknowledgeWorkspaceDraft: async (_id, key) => {
      if (!stored || stored.seq !== key.seq) return false;
      if (workspaceDraftState(stored, result.workspace) !== 'matching')
        return false;
      watermark = key.seq;
      stored = null;
      return true;
    },
  });
  const old = queue.prepareSubmission(baseline.workspace, baseline.workspace);
  await queue.flush();
  const next = queue.confirm(result.workspace, result.workspace);
  assert.ok(next.seq > old.seq);
  await queue.flush();
  await queue.acknowledge(old);
  assert.ok(
    stored,
    'a delayed old acknowledgement must not delete the new baseline',
  );
  assert.equal(queue.snapshot()?.lastSubmitted, undefined);
  assert.deepEqual(queue.snapshot()?.baseline, result.workspace);
  await queue.acknowledge(next);
  assert.equal(stored, null);
  assert.equal(watermark, next.seq);
  assert.equal(
    workspaceDraftState(
      {
        sessionId: 'old',
        seq: 1,
        baseline: baseline.workspace,
        workspace: baseline.workspace,
      },
      result.workspace,
    ),
    'conflict',
  );
});

test('both lost replies keep an adopted job unresolved until the identical receipt is retried', async () => {
  const { baseline, result } = fixture('video');
  const calls: [string, number][] = [];
  let callsToDrop = 2;
  const bridge = {
    adoptArkJob: async (jobId: string, revision: number) => {
      calls.push([jobId, revision]);
      if (callsToDrop-- > 0) throw new Error('committed, reply lost');
      return result;
    },
    listArkJobs: async () => [
      {
        id: 'job',
        phase: 'adopted',
        adoptedShotId: result.shotId,
      } as ArkGenerationJob,
    ],
    getGenerationWorkspace: async () => result.workspace,
  };
  await assert.rejects(requestArkAdoption(bridge, baseline), /reply lost/);
  assert.equal(await arkAdoptionDidNotCommit(bridge, baseline), false);
  const confirmed = await requestArkAdoption(bridge, baseline);
  assert.deepEqual(calls, [
    ['job', 8],
    ['job', 8],
    ['job', 8],
  ]);
  assert.equal(
    confirmed.workspace.shots.length,
    baseline.workspace.shots.length + 1,
  );
  assert.equal(
    confirmed.snapshot.canvas.cards.length,
    baseline.project.canvas.cards.length + 1,
  );
});
