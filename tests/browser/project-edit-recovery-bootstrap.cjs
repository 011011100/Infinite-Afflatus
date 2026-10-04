// Isolated fault injection around production handlers; never loaded by the app.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const fs = require('node:fs/promises');
const { rename, writeFile } = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { dialog, ipcMain } = require('electron');

(async () => {
  const config = JSON.parse(
    readFileSync(process.env.AFFLATUS_EDIT_RECOVERY_FIXTURE, 'utf8'),
  );
  assert.equal(
    readFileSync(join(config.scratch, '.fixture-owner'), 'utf8'),
    config.owner,
  );
  assert.equal(dirname(config.profile), config.scratch);
  assert.equal(process.env.AFFLATUS_USER_DATA, config.profile);
  const handle = ipcMain.handle.bind(ipcMain);
  let injected = false;
  let lostReplies = 0;
  let cleanupArmed = false;
  const publishMarker = async (value) => {
    const partial = `${config.marker}.partial`;
    await writeFile(partial, JSON.stringify(value), { flag: 'wx' });
    await rename(partial, config.marker);
  };
  if (config.fault === 'trim-cleanup') {
    const unlink = fs.unlink.bind(fs);
    fs.unlink = async (path) => {
      if (
        cleanupArmed &&
        !injected &&
        typeof path === 'string' &&
        dirname(path) === join(config.profile, 'project-edit-drafts') &&
        JSON.parse(readFileSync(path, 'utf8')).kind === 'trim'
      ) {
        injected = true;
        await publishMarker({ fault: config.fault, path });
        throw Object.assign(
          new Error('Fixture: draft unlink failed after committed trim'),
          { code: 'EACCES' },
        );
      }
      return unlink(path);
    };
    syncBuiltinESMExports();
  }
  ipcMain.handle = (channel, handler) =>
    handle(channel, async (event, ...args) => {
      if (
        !injected &&
        config.fault === 'trim-unavailable' &&
        channel === 'project:canvas-patch' &&
        args[0] === config.projectId
      ) {
        injected = true;
        const deadline = Date.now() + 5000;
        for (;;) {
          try {
            await rename(config.database, config.heldDatabase);
            break;
          } catch (error) {
            if (
              process.platform !== 'win32' ||
              error.code !== 'EBUSY' ||
              Date.now() >= deadline
            )
              throw error;
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
        }
        // Production patchCanvas must now reject the unavailable database.
        try {
          await handler(event, ...args);
          throw new Error(
            'Unexpected trim write succeeded after database removal',
          );
        } catch (error) {
          await publishMarker({ fault: config.fault, error: String(error) });
          throw error;
        }
      }
      const armCleanup =
        config.fault === 'trim-cleanup' &&
        channel === 'draft:recover-project-edit' &&
        args[0] === config.projectId;
      if (armCleanup) cleanupArmed = true;
      let result;
      try {
        result = await handler(event, ...args);
      } finally {
        if (armCleanup) cleanupArmed = false;
      }
      if (
        lostReplies < (config.lostReplies ?? 1) &&
        config.fault === 'name-lost-reply' &&
        channel === 'draft:recover-project-edit' &&
        args[0] === config.projectId
      ) {
        lostReplies++;
        // The real service has already committed and acknowledged A. Only its
        // IPC response is lost; the renderer must protect later B with receipt A.
        await publishMarker({
          fault: config.fault,
          name: result.project.name,
          count: lostReplies,
        });
        throw new Error('Fixture: lost project-edit IPC reply after commit');
      }
      return result;
    });
  dialog.showSaveDialog = async () => ({
    canceled: false,
    filePath: config.exportPath,
  });
  await import(pathToFileURL(config.main).href);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  require('electron').app.exit(1);
});
