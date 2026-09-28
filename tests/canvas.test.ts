import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Library } from '../src/main/storage/library';
import {
  applyCanvasPatch,
  type CanvasCard,
  type CanvasDocument,
  cardWidth,
  reconcileCanvas,
} from '../src/shared/canvas/model';
import {
  findSnapTarget,
  joinCards,
  reversePatch,
  splitCard,
} from '../src/shared/canvas/operations';
import type { Asset } from '../src/shared/models';

function card(x: number, count = 1): CanvasCard {
  return {
    id: randomUUID(),
    position: { x, y: 100 },
    assetIds: Array.from({ length: count }, () => randomUUID()),
  };
}
function document(cards: CanvasCard[]): CanvasDocument {
  return { version: 1, revision: 0, cards };
}
function asset(id = randomUUID()): Asset {
  return {
    id,
    name: '视频.mp4',
    kind: 'video',
    relativePath: `assets/videos/${id}.mp4`,
    size: 10,
    sha256: 'fake-for-model-test',
  };
}

for (const side of ['left', 'right'] as const) {
  test(`joining two groups at the ${side} preserves both internal orders and undo restores original positions`, () => {
    const a = card(100, 2);
    const b = card(800, 3);
    const patch = joinCards(a, b, side);
    const joined = applyCanvasPatch(document([a, b]), patch);
    assert.equal(joined.cards.length, 1);
    assert.deepEqual(
      joined.cards[0]?.assetIds,
      side === 'left'
        ? [...a.assetIds, ...b.assetIds]
        : [...b.assetIds, ...a.assetIds],
    );
    const restored = applyCanvasPatch(joined, reversePatch(patch));
    assert.deepEqual(restored.cards, [a, b]);
    assert.deepEqual(applyCanvasPatch(restored, patch).cards, joined.cards);
  });
}

test('snap tolerance is in screen pixels; vertical proximity alone and moving away do not join', () => {
  const target = card(100);
  for (const zoom of [0.25, 1, 2]) {
    const moving = card(100 + cardWidth(target) + 24 / zoom);
    assert.deepEqual(findSnapTarget(moving, [target, moving], zoom), {
      targetId: target.id,
      side: 'right',
    });
    assert.equal(
      findSnapTarget(
        { ...moving, position: { x: moving.position.x + 10 / zoom, y: 100 } },
        [target],
        zoom,
      ),
      null,
    );
    assert.equal(
      findSnapTarget(
        { ...moving, position: { ...moving.position, y: 100 + 41 / zoom } },
        [target],
        zoom,
      ),
      null,
    );
    assert.deepEqual(
      findSnapTarget(
        {
          ...moving,
          position: {
            x: target.position.x - cardWidth(moving) - 24 / zoom,
            y: 100,
          },
        },
        [target],
        zoom,
      ),
      { targetId: target.id, side: 'left' },
    );
  }
});

test('splitting preserves all ordered asset references; undo restores one group', () => {
  const group = card(-300, 6);
  const patch = splitCard(
    group,
    group.assetIds.map(() => randomUUID()),
  );
  const split = applyCanvasPatch(document([group]), patch);
  assert.equal(split.cards.length, 6);
  assert.deepEqual(
    split.cards.flatMap((item) => item.assetIds),
    group.assetIds,
  );
  assert.ok(
    split.cards.every((item, index) => item.position.x === -300 + index * 336),
  );
  assert.deepEqual(applyCanvasPatch(split, reversePatch(patch)).cards, [group]);
});

test('patches reject stale positions, duplication, invented assets, invalid coordinates and colliding IDs', () => {
  const a = card(100);
  const b = card(600);
  const canvas = document([a, b]);
  assert.throws(
    () =>
      applyCanvasPatch(canvas, {
        before: [{ ...a, position: { x: 99, y: 100 } }],
        after: [a],
      }),
    /已发生变化/,
  );
  assert.throws(
    () =>
      applyCanvasPatch(canvas, {
        before: [a],
        after: [{ ...a, assetIds: [randomUUID()] }],
      }),
    /不能增删素材/,
  );
  assert.throws(
    () =>
      applyCanvasPatch(canvas, {
        before: [a],
        after: [{ ...a, assetIds: [...a.assetIds, ...a.assetIds] }],
      }),
    /重复/,
  );
  assert.throws(
    () =>
      applyCanvasPatch(canvas, {
        before: [a],
        after: [{ ...a, position: { x: Number.NaN, y: 0 } }],
      }),
    /无效/,
  );
  assert.throws(
    () =>
      applyCanvasPatch(canvas, { before: [a], after: [{ ...a, id: b.id }] }),
    /无效/,
  );
  assert.throws(
    () => applyCanvasPatch(canvas, { before: [], after: [] }),
    /不能为空/,
  );
  assert.deepEqual(canvas, document([a, b]));
});

test('legacy/new imports receive deterministic cards; existing grouping and coordinates stay intact', () => {
  const first = asset();
  const second = asset();
  const legacy = reconcileCanvas(undefined, [first, second]);
  assert.deepEqual(legacy, reconcileCanvas(undefined, [first, second]));
  assert.equal(legacy.cards[0]?.id, first.id);
  const a = legacy.cards[0];
  const b = legacy.cards[1];
  assert.ok(a && b);
  const grouped = applyCanvasPatch(legacy, joinCards(a, b, 'left'));
  const added = asset();
  const imported = reconcileCanvas(grouped, [first, second, added]);
  assert.deepEqual(imported.cards[0], grouped.cards[0]);
  assert.equal(imported.cards[1]?.id, added.id);
  assert.equal(imported.cards[1]?.position.y, 352);
  assert.throws(
    () =>
      reconcileCanvas(
        { ...grouped, version: 99 } as unknown as CanvasDocument,
        [first, second],
      ),
    /版本不受支持/,
  );
});

async function fixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-canvas-')),
  );
  const root = join(base, 'projects');
  const data = join(base, 'app');
  const library = await Library.open(data, root);
  const { project } = await library.projects.create('画布测试');
  const add = async () => {
    await library.acceptResult(
      {
        projectId: project.id,
        resultKey: randomUUID(),
        name: '视频.mp4',
        kind: 'video',
        extension: 'mp4',
      },
      Readable.from('storage test bytes'),
    );
    await library.saves.idle();
  };
  return {
    base,
    root,
    data,
    library,
    project,
    add,
    dispose: async () => {
      await library.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('legacy read is non-mutating; positions, grouping and order survive database reopen', async () => {
  const f = await fixture();
  try {
    await f.add();
    await f.add();
    const file = join(f.root, f.project.folder, 'project.sqlite');
    const bytes = await readFile(file);
    const initial = await f.library.projects.open(f.project.id);
    assert.deepEqual(await readFile(file), bytes);
    const [a, b] = initial.canvas.cards;
    assert.ok(a && b);
    const moved = { ...a, position: { x: -87, y: 209 } };
    await f.library.projects.patchCanvas(f.project.id, {
      before: [a],
      after: [moved],
    });
    const joined = await f.library.projects.patchCanvas(
      f.project.id,
      joinCards(moved, b, 'left'),
    );
    await f.library.close();
    const reopened = await Library.open(f.data, f.root);
    try {
      assert.deepEqual(
        (await reopened.projects.open(f.project.id)).canvas,
        joined.canvas,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.dispose();
  }
});

test('an import arriving between snapshot and merge is retained, including through undo; stale edits roll back', async () => {
  const f = await fixture();
  try {
    await f.add();
    await f.add();
    const initial = await f.library.projects.open(f.project.id);
    const [a, b] = initial.canvas.cards;
    assert.ok(a && b);
    const patch = joinCards(a, b, 'right');
    await f.add();
    const joined = await f.library.projects.patchCanvas(f.project.id, patch);
    assert.equal(joined.assets.length, 3);
    assert.equal(joined.canvas.cards.length, 2);
    await assert.rejects(
      f.library.projects.patchCanvas(f.project.id, patch),
      /已发生变化/,
    );
    assert.deepEqual(
      (await f.library.projects.open(f.project.id)).canvas,
      joined.canvas,
    );
    const undone = await f.library.projects.patchCanvas(
      f.project.id,
      reversePatch(patch),
    );
    assert.equal(undone.canvas.cards.length, 3);
    assert.equal(
      new Set(undone.canvas.cards.flatMap((item) => item.assetIds)).size,
      3,
    );
  } finally {
    await f.dispose();
  }
});

test('canvas writes honor the migration gate and resume against the current directory', async () => {
  const f = await fixture();
  try {
    await f.add();
    await f.add();
    const initial = await f.library.projects.open(f.project.id);
    const [a, b] = initial.canvas.cards;
    assert.ok(a && b);
    const patch = joinCards(a, b, 'right');
    await f.library.gate.block();
    await assert.rejects(f.library.projects.patchCanvas(f.project.id, patch));
    f.library.gate.release();
    const target = join(f.base, 'moved');
    await mkdir(target);
    const preview = await f.library.migration.prepare(target);
    await f.library.migration.start(preview.token);
    await f.library.migration.idle();
    const saved = await f.library.projects.patchCanvas(f.project.id, patch);
    assert.equal(saved.canvas.cards.length, 1);
    assert.deepEqual(
      (await f.library.projects.open(f.project.id)).canvas,
      saved.canvas,
    );
    await assert.rejects(
      readFile(join(f.root, f.project.id, 'project.sqlite')),
      { code: 'ENOENT' },
    );
  } finally {
    await f.dispose();
  }
});
