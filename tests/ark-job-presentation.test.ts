import assert from 'node:assert/strict';
import test from 'node:test';
import {
  arkDuplicateRisk,
  arkJobActions,
  arkPhaseLabel,
} from '../src/renderer/src/features/generation/ark/ark-job-presentation';
import type { ArkGenerationJob } from '../src/shared/generation/ark-types';

const job = (
  phase: ArkGenerationJob['phase'],
  changes: Partial<ArkGenerationJob> = {},
): ArkGenerationJob => ({
  id: 'job',
  projectId: 'project',
  shotId: 'shot',
  groupId: 'group',
  kind: 'video',
  modelId: 'ep-explicit',
  capability: 'seedance-2.0',
  prompt: 'First\n\nSecond',
  parameters: {
    model: 'seedance-2.0',
    ratio: '16:9',
    resolution: '720p',
    duration: 5,
    generateAudio: false,
  },
  references: [],
  phase,
  createdAt: '2026-10-08T00:00:00Z',
  updatedAt: '2026-10-08T00:00:00Z',
  remoteTaskId: 'remote',
  locallyStopped: false,
  error: null,
  ...changes,
});
test('no renderer action risks deleting a remotely completed task', () => {
  assert.equal(arkJobActions(job('queued')).cancel, false);
  for (const phase of Object.keys(
    arkPhaseLabel,
  ) as ArkGenerationJob['phase'][]) {
    assert.equal(arkJobActions(job(phase)).cancel, false, phase);
  }
  assert.equal(
    arkJobActions(job('queued', { remoteTaskId: '' })).cancel,
    false,
  );
});
test('local pause is separate from remote cancellation and resume query', () => {
  assert.equal(arkJobActions(job('running')).stop, true);
  const stopped = arkJobActions(job('running', { locallyStopped: true }));
  assert.equal(stopped.stop, false);
  assert.equal(stopped.query, true);
  assert.equal(stopped.cancel, false);
});
test('unknown submission without a remote ID has no automatic retry action', () => {
  const unknown = job('submission_unknown', { remoteTaskId: '' });
  assert.deepEqual(arkJobActions(unknown), {
    query: false,
    stop: false,
    cancel: false,
    download: false,
    save: false,
    adopt: false,
  });
  assert.equal(arkDuplicateRisk([unknown]), true);
  assert.equal(arkDuplicateRisk([job('failed')]), false);
});
test('download and save failures expose separate retries, never generation', () => {
  assert.deepEqual(arkJobActions(job('download_failed')), {
    query: false,
    stop: false,
    cancel: false,
    download: true,
    save: false,
    adopt: false,
  });
  assert.deepEqual(arkJobActions(job('save_failed')), {
    query: false,
    stop: false,
    cancel: false,
    download: false,
    save: true,
    adopt: false,
  });
  assert.notEqual(arkPhaseLabel.failed, arkPhaseLabel.download_failed);
  assert.notEqual(arkPhaseLabel.download_failed, arkPhaseLabel.save_failed);
});
test('only an unadopted saved candidate can be adopted', () => {
  assert.equal(arkJobActions(job('candidate')).adopt, false);
  assert.equal(
    arkJobActions(job('candidate', { candidateAssetId: 'asset' })).adopt,
    true,
  );
  assert.equal(
    arkJobActions(job('adopted', { candidateAssetId: 'asset' })).adopt,
    false,
  );
});

test('restored history exposes only the original save verification action', () => {
  assert.deepEqual(arkJobActions(job('recovery_blocked')), {
    query: false,
    stop: false,
    cancel: false,
    download: false,
    save: true,
    adopt: false,
  });
});

test('restored pre-result remote task exposes explicit original-ID query only with backend proof', () => {
  assert.deepEqual(
    arkJobActions(
      job('recovery_blocked', {
        locallyStopped: true,
        canResumeOriginalTask: true,
      }),
    ),
    {
      query: true,
      stop: false,
      cancel: false,
      download: false,
      save: false,
      adopt: false,
    },
  );
  assert.equal(
    arkJobActions(
      job('recovery_blocked', {
        remoteTaskId: '',
        canResumeOriginalTask: true,
      }),
    ).query,
    false,
  );
});
