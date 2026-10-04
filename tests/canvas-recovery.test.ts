import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canResumeCanvas } from '../src/renderer/src/features/workspace/canvas-recovery';
import type { Asset, ProjectSnapshot } from '../src/shared/models';

const asset = (id: string): Asset => ({
  id,
  name: `${id}.txt`,
  relativePath: `assets/text/${id}.txt`,
  size: 8,
  sha256: id.repeat(64).slice(0, 64),
  kind: 'text',
  usage: 'reference',
});
const snapshot = (assets: Asset[] = []): ProjectSnapshot => ({
  project: { id: 'project', folder: 'project', name: 'name', updatedAt: '' },
  viewport: { x: 0, y: 0, zoom: 1 },
  canvas: { version: 1, revision: 3, cards: [] },
  assets,
});

test('recovery accepts exact saved reference additions whose UI notification has not refreshed yet', () => {
  const a = asset('a');
  const b = asset('b');
  assert.equal(canResumeCanvas(snapshot(), snapshot([a]), [a]), true);
  assert.equal(canResumeCanvas(snapshot([a]), snapshot([a, b]), [b, a]), true);
  assert.equal(canResumeCanvas(snapshot([a]), snapshot([a])), true);
});

test('older project databases remain blocked even when the unrefreshed baseline was empty', () => {
  const a = asset('a');
  const b = asset('b');
  for (const remote of [snapshot(), snapshot([a]), snapshot([b])])
    assert.equal(canResumeCanvas(snapshot(), remote, [a, b]), false);
  assert.equal(canResumeCanvas(snapshot([a]), snapshot(), [a]), false);
});

test('proof cannot authorize changed canvas, existing asset records, removed assets or changed order', () => {
  const a = asset('a');
  const b = asset('b');
  const base = snapshot([a]);
  const changedCanvas = snapshot([a, b]);
  changedCanvas.canvas.revision++;
  assert.equal(canResumeCanvas(base, changedCanvas, [a, b]), false);
  assert.equal(
    canResumeCanvas(snapshot([a, b]), snapshot([b, a]), [a, b]),
    false,
  );
  assert.equal(canResumeCanvas(base, snapshot([b]), [b]), false);
  const changed = { ...a, name: 'external change' };
  assert.equal(
    canResumeCanvas(base, snapshot([changed, b]), [changed, b]),
    false,
  );
  const wrongProject = snapshot([a, b]);
  wrongProject.project.id = 'other';
  assert.equal(canResumeCanvas(base, wrongProject, [a, b]), false);
});

test('unknown additions and mismatched reference fields remain conflicts', () => {
  const a = asset('a');
  const changes: Partial<Asset>[] = [
    { id: 'other' },
    { name: 'renamed' },
    { relativePath: 'assets/text/other.txt' },
    { size: 9 },
    { sha256: 'b'.repeat(64) },
    { kind: 'image' },
  ];
  assert.equal(canResumeCanvas(snapshot(), snapshot([a])), false);
  for (const changeset of changes)
    assert.equal(
      canResumeCanvas(snapshot(), snapshot([{ ...a, ...changeset }]), [a]),
      false,
    );
  const nonReference = { ...a };
  delete nonReference.usage;
  assert.equal(
    canResumeCanvas(snapshot(), snapshot([nonReference]), [a]),
    false,
  );
  const video = { ...nonReference, kind: 'video' as const };
  assert.equal(canResumeCanvas(snapshot(), snapshot([video]), [video]), false);
  assert.equal(canResumeCanvas(snapshot(), snapshot([a, a]), [a]), false);
  assert.equal(canResumeCanvas(snapshot(), snapshot([a]), [a, a]), false);
});
