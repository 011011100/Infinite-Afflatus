import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Library } from '../../src/main/storage/library';
import {
  assertSavedStagingState,
  type SavedStagingContract,
} from './saved-staging-history';

const [file] = process.argv.slice(2);
assert.ok(file);
const contract: SavedStagingContract = JSON.parse(await readFile(file, 'utf8'));
const library = await Library.open(
  contract.state.app,
  join(contract.state.app, 'unused-default-must-not-appear'),
);
try {
  await library.saves.idle();
  await assertSavedStagingState(library, contract);
  console.log(
    `PASS ordinary independent Library restart: saved staging ${contract.mode}`,
  );
} finally {
  await library.close();
}
