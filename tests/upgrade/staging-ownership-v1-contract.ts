import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import type { PartOwnership } from '../../src/main/saving/staging-ownership';
import type { SaveJob } from '../../src/shared/models';
import { assertOriginalFiles, fileHash, type HistoricalData } from './history';
import type { HistoricalStagingFile } from './staging-cleanup-contract';

export interface OwnershipV1Record extends HistoricalStagingFile {
  variant: 'failed' | 'cancelled' | 'cloud' | 'ready';
  job: SaveJob;
  exists: boolean;
}
export interface OwnershipV1Historical {
  writerCommit: string;
  mode: 'owned' | 'replaced' | 'journal-missing' | 'journal-present';
  records: OwnershipV1Record[];
  sourceFiles: HistoricalStagingFile[];
  jobs: SaveJob[];
  ownership: { version: 1; entries: PartOwnership[] };
  execution?: {
    removedCount: number;
    removedBytes: number;
    retained: unknown[];
  };
}
export interface OwnershipV1Contract {
  app: string;
  expected: HistoricalData;
  historical: OwnershipV1Historical;
  removedIds: string[];
  eligibleIds: string[];
  replacement?: {
    jobId: string;
    original: HistoricalStagingFile;
    replacement: HistoricalStagingFile;
  };
}

export async function assertOwnershipV1Files(contract: OwnershipV1Contract) {
  const unchanged: HistoricalStagingFile[] = [
    ...contract.historical.sourceFiles,
  ];
  for (const record of contract.historical.records) {
    if (!record.exists || contract.removedIds.includes(record.job.id)) {
      await assert.rejects(access(record.file), { code: 'ENOENT' });
    } else if (contract.replacement?.jobId === record.job.id) {
      unchanged.push(
        contract.replacement.original,
        contract.replacement.replacement,
      );
    } else unchanged.push(record);
  }
  for (const file of unchanged) {
    assert.equal(
      (await readFile(file.file)).length,
      file.size,
      `Size changed: ${file.file}`,
    );
    assert.equal(
      await fileHash(file.file),
      file.sha256,
      `Bytes changed: ${file.file}`,
    );
  }
  await assertOriginalFiles(contract.expected);
}

export function expectedOwnership(contract: OwnershipV1Contract) {
  return {
    ...contract.historical.ownership,
    entries: contract.historical.ownership.entries.filter(
      (entry) => !contract.removedIds.includes(entry.jobId),
    ),
  };
}

export function expectedJobs(contract: OwnershipV1Contract) {
  return contract.historical.jobs.filter(
    (job) => !contract.removedIds.includes(job.id),
  );
}
