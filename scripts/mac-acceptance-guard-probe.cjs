// No app/library startup, no native safeStorage calls, no BrowserWindow.
const assert = require('node:assert/strict');
const { app, safeStorage } = require('electron');
const { marker } = require('./mac-acceptance-safety.cjs');

try {
  const guard = globalThis[marker];
  // A missing bootstrap fails before even querying encryption availability.
  assert.ok(guard, 'safeStorage guard marker missing; no methods called.');
  assert.equal(require.main, module);
  assert.equal(process.mainModule, module);
  assert.equal(process.argv[1], __filename);
  assert.equal(safeStorage.isEncryptionAvailable(), false);
  assert.throws(() => safeStorage.encryptString('synthetic'), /forbids native/);
  assert.throws(
    () => safeStorage.decryptString(Buffer.from('synthetic')),
    /forbids native/,
  );
  assert.deepEqual(
    [
      guard.snapshot().availabilityChecks,
      guard.snapshot().encryptAttempts,
      guard.snapshot().decryptAttempts,
    ],
    [1, 1, 1],
  );
  console.log('PASS guard probe: native methods blocked; argv/main preserved.');
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
}
