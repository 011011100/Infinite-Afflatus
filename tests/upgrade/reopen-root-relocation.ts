import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Library } from '../../src/main/storage/library';
import {
  assertRelocatedLibrary,
  type RelocatedHistory,
} from './root-relocation-contract';

const file = process.argv[2];
assert.ok(file);
const contract: RelocatedHistory = JSON.parse(await readFile(file, 'utf8'));
const library = await Library.open(
  contract.state.app,
  join(contract.data, 'unused-default-root'),
);
try {
  await library.saves.idle();
  await assertRelocatedLibrary(library, contract);
  console.log(
    'PASS ordinary relocated-root restart: queued reference saved once; saved missing target retained; historical media, drafts and independent project unchanged',
  );
} finally {
  await library.close();
}
