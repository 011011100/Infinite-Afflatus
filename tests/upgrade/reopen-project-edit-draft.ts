import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertProjectEditPreserved,
  openProjectEditServices,
  type ProjectEditUpgradeContract,
} from './project-edit-draft-contract';

const [file] = process.argv.slice(2);
assert.ok(file);
const contract: ProjectEditUpgradeContract = JSON.parse(
  await readFile(file, 'utf8'),
);
const services = openProjectEditServices(contract.app, contract.defaultRoot);
try {
  await assertProjectEditPreserved(contract, services);
} finally {
  await services.close();
}
