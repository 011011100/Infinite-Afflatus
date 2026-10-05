import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppStore } from '../../src/main/storage/app-store';
import { fileHash } from './history';
import {
  assertMovementSettings,
  type MovementShortcutReopen,
} from './movement-shortcuts-contract';

const [file] = process.argv.slice(2);
assert.ok(file);
const contract: MovementShortcutReopen = JSON.parse(
  await readFile(file, 'utf8'),
);
const database = join(contract.history.app, 'app.sqlite');
const before = await fileHash(database);
// Settings-only upgrade: never start workers or consume the historical ready result.
const store = new AppStore(database, contract.history.defaultRoot);
try {
  await assertMovementSettings(contract, store);
} finally {
  store.close();
}
assert.equal(
  await fileHash(database),
  before,
  'Current settings reads must not rewrite the old database',
);
