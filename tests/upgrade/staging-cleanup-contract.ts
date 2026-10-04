import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { ProjectSummary, SaveJob } from '../../src/shared/models';
import { assertOriginalFiles, fileHash, type HistoricalData } from './history';

export interface HistoricalStagingFile {
  file: string;
  size: number;
  sha256: string;
}
export interface HistoricalStagingJob extends HistoricalStagingFile {
  job: SaveJob;
}
export interface HistoricalStagingCleanup {
  writerCommit: string;
  project: ProjectSummary;
  partials: HistoricalStagingJob[];
  ready: HistoricalStagingJob;
  files: HistoricalStagingFile[];
  jobs: SaveJob[];
}
export interface StagingCleanupLegacyContract {
  app: string;
  expected: HistoricalData;
  historical: HistoricalStagingCleanup;
  cleaned?: { jobId: string; file: string; source: HistoricalStagingFile };
}

export async function assertLegacyStagingBytes(
  contract: StagingCleanupLegacyContract,
) {
  const { historical, expected } = contract;
  for (const file of [
    ...historical.files,
    ...historical.partials,
    historical.ready,
  ]) {
    assert.equal(
      (await readFile(file.file)).length,
      file.size,
      `Historical size changed: ${file.file}`,
    );
    assert.equal(
      await fileHash(file.file),
      file.sha256,
      `Historical bytes changed: ${file.file}`,
    );
  }
  await assertOriginalFiles(expected);
  if (contract.cleaned) {
    assert.equal(
      await fileHash(contract.cleaned.source.file),
      contract.cleaned.source.sha256,
    );
    assert.equal(
      (await readFile(contract.cleaned.source.file)).length,
      contract.cleaned.source.size,
    );
  }
}
