const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const Module = require('node:module');
const { app, safeStorage } = require('electron');
const { installSafeStorageGuard } = require('./mac-acceptance-safety.cjs');

try {
  if (!process.versions.electron || process.type !== 'browser')
    throw new Error('Acceptance bootstrap requires the Electron main process.');
  const target = process.argv[2];
  if (!target || target.startsWith('-'))
    throw new Error('Missing guarded Electron entry.');
  const entry = resolve(target);
  installSafeStorageGuard(safeStorage, {
    directory: process.env.AFFLATUS_TEST_SAFE_STORAGE_REPORTS,
    stage: process.env.AFFLATUS_TEST_STAGE,
    entry,
  });
  process.argv.splice(1, 1);
  process.argv[1] = entry;
  if (entry.endsWith('.cjs')) {
    // Preserve require.main/process.mainModule for CJS child-mode harnesses.
    Module._load(entry, null, true);
  } else {
    // Current non-CJS entries are production ESM main files.
    import(pathToFileURL(entry).href).catch((error) => {
      console.error(error);
      app.exit(1);
    });
  }
} catch (error) {
  console.error(error);
  app.exit(1);
}
