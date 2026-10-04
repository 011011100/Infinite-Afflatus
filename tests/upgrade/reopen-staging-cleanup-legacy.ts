import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Staging } from '../../src/main/saving/staging';
import { StagingCleanupService } from '../../src/main/saving/staging-cleanup-service';
import { AppStore } from '../../src/main/storage/app-store';
import {
  assertLegacyStagingBytes,
  type StagingCleanupLegacyContract,
} from './staging-cleanup-contract';

const [file] = process.argv.slice(2);
assert.ok(file);
const contract: StagingCleanupLegacyContract = JSON.parse(
  await readFile(file, 'utf8'),
);
const store = new AppStore(
  join(contract.app, 'app.sqlite'),
  contract.expected.root,
);
const staging = new Staging(join(contract.app, 'staging'), store, () => {});
const cleanup = new StagingCleanupService(staging, store, () => {});
try {
  await staging.recover();
  await cleanup.recover();
  const inspection = await cleanup.inspect();
  const preview = await cleanup.preview();
  assert.equal(preview.token, null);
  assert.deepEqual(preview.files, []);
  assert.equal(preview.bytes, 0);
  for (const entry of contract.historical.partials) {
    const item = inspection.items.find((item) => item.jobId === entry.job.id);
    assert.ok(item);
    assert.equal(item.canCleanup, false);
    assert.ok(item.reason);
    assert.ok(preview.retained.some((item) => item.jobId === entry.job.id));
    assert.ok(
      !JSON.stringify(store.get('stagingPartOwnership')).includes(entry.job.id),
      'opening must not adopt a historical partial',
    );
  }
  assert.deepEqual(store.jobs(), contract.historical.jobs);
  assert.ok(contract.cleaned);
  assert.throws(() => store.job(contract.cleaned?.jobId ?? ''), /不存在/);
  await assert.rejects(access(contract.cleaned.file), { code: 'ENOENT' });
  await assertLegacyStagingBytes(contract);
} finally {
  await cleanup.close();
  await staging.idle();
  store.close();
}
