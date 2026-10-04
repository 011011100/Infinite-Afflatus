import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppStore } from '../../src/main/storage/app-store';
import { fileHash } from './history';
import {
  assertMediaToolPreservation,
  assertSettingsRead,
  type MediaToolUpgradeContract,
} from './media-tool-settings-contract';

const [file] = process.argv.slice(2);
assert.ok(file);
const contract: MediaToolUpgradeContract = JSON.parse(
  await readFile(file, 'utf8'),
);
const database = join(contract.app, 'app.sqlite');
const before = await fileHash(database);
// Do not start Library/SaveQueue: a settings upgrade must not consume queued media.
const store = new AppStore(database, contract.defaultRoot);
try {
  await assertSettingsRead(contract, store);
  await assertMediaToolPreservation(contract, store);
} finally {
  store.close();
}
assert.equal(
  await fileHash(database),
  before,
  'reopening and diagnosing settings did not rewrite the application database',
);
