import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertRescuePreserved,
  openRescueServices,
  type RescueUpgradeContract,
} from './rescue-contract';

const [path] = process.argv.slice(2);
assert.ok(path);
const contract: RescueUpgradeContract = JSON.parse(
  await readFile(path, 'utf8'),
);
const services = openRescueServices(contract.app, contract.defaultRoot);
try {
  await assertRescuePreserved(contract, services);
  console.log(`Rescue import independently reopened: ${contract.history.mode}`);
} finally {
  await services.close();
}
