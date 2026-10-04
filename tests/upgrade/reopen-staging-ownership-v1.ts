import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Staging } from '../../src/main/saving/staging';
import { StagingCleanupService } from '../../src/main/saving/staging-cleanup-service';
import { AppStore } from '../../src/main/storage/app-store';
import {
  assertOwnershipV1Files,
  expectedJobs,
  expectedOwnership,
  type OwnershipV1Contract,
} from './staging-ownership-v1-contract';

const [file] = process.argv.slice(2);
assert.ok(file);
const contract: OwnershipV1Contract = JSON.parse(await readFile(file, 'utf8'));
const store = new AppStore(
  join(contract.app, 'app.sqlite'),
  contract.expected.root,
);
const staging = new Staging(join(contract.app, 'staging'), store, () => {});
const cleanup = new StagingCleanupService(staging, store, () => {});
try {
  await staging.recover();
  await cleanup.recover();
  assert.deepEqual(store.jobs(), expectedJobs(contract));
  assert.deepEqual(
    store.get('stagingPartOwnership'),
    expectedOwnership(contract),
  );
  const preview = await cleanup.preview();
  assert.deepEqual(
    preview.files.map((item) => item.jobId).sort(),
    [...contract.eligibleIds].sort(),
  );
  assert.equal(!!preview.token, contract.eligibleIds.length > 0);
  // A present historical intent may be offered for a NEW confirmation, never replayed on restart.
  cleanup.cancel();
  await assertOwnershipV1Files(contract);
} finally {
  await cleanup.close();
  await staging.idle();
  store.close();
}
