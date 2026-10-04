import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertBackupV1Reopen,
  type RestoredAppBackupV1,
} from './app-backup-v1-contract';

const file = process.argv[2];
assert.ok(file);
const contract: RestoredAppBackupV1 = JSON.parse(await readFile(file, 'utf8'));
await assertBackupV1Reopen(contract);
