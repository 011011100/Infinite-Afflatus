import assert from 'node:assert/strict';
import { withProject } from '../../src/main/projects/project-database';

const file = process.argv[2];
assert.ok(file);
withProject(file, true, (db) => {
  db.exec('DELETE FROM assets');
  db.prepare("UPDATE metadata SET value = ? WHERE key = 'viewport'").run(
    JSON.stringify({ x: 9999, y: 9999, zoom: 2 }),
  );
  // Exit before COMMIT. The next process must recover all previously committed data.
  process.exit(73);
});
