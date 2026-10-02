import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Library } from '../../src/main/storage/library';
import type { GenerationWorkspace } from '../../src/shared/generation/workspace';
import type { ProjectSnapshot } from '../../src/shared/models';
import { fileHash, type HistoricalData } from './history';

export function assertWorkspace(
  expected: HistoricalData,
  actual: GenerationWorkspace,
) {
  if (expected.workspace) {
    assert.deepEqual(actual, expected.workspace);
    return;
  }
  // Explicit expected legacy conversion, independent of the current converter.
  assert.equal(actual.shots.length, 1);
  const shot = actual.shots[0];
  assert.ok(shot);
  assert.deepEqual(
    shot.nodes.flatMap((node) => (node.type === 'text' ? [node.text] : [])),
    [expected.draft.prompt],
  );
  assert.deepEqual(
    shot.nodes.flatMap((node) => (node.type === 'asset' ? [node.assetId] : [])),
    expected.draft.referenceIds,
  );
  assert.equal(shot.groups.length, 1);
  const group = shot.groups[0];
  assert.ok(group);
  assert.deepEqual(group.parameters, expected.draft.parameters);
  assert.ok(shot.nodes.every((node) => node.groupId === group.id));
}

export function withoutTimestamp(snapshot: ProjectSnapshot) {
  const { updatedAt: _, ...project } = snapshot.project;
  return { ...snapshot, project };
}

export async function assertQueue(library: Library, expected: HistoricalData) {
  const queued = library.store.job(expected.queued.id);
  assert.equal(
    queued.status,
    'saved',
    queued.error ?? 'Pending result not saved',
  );
  assert.equal(queued.sha256, expected.queued.sha256);
  const pending = await library.projects.open(expected.pendingProject.id);
  assert.equal(
    pending.assets.length,
    1,
    'Retry must not duplicate pending assets',
  );
  const asset = pending.assets[0];
  assert.ok(asset);
  assert.equal(asset.id, expected.queued.id);
  assert.equal(asset.name, expected.queued.name);
  assert.equal(asset.size, expected.queued.size);
  assert.equal(asset.sha256, expected.queued.sha256);
  assert.equal(
    await fileHash(
      join(expected.root, pending.project.folder, asset.relativePath),
    ),
    expected.queued.sha256,
  );
  assert.equal(library.store.jobs().length, expected.jobs.length);
  for (const job of expected.jobs.filter((entry) => entry.id !== queued.id))
    assert.deepEqual(library.store.job(job.id), job);
}

export function assertIntegrity(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(
      db
        .prepare('PRAGMA integrity_check')
        .all()
        .map((row) => row.integrity_check),
      ['ok'],
    );
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
  }
}
