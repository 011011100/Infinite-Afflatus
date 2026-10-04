// Read-only evidence for the synthetic unavailable-project fixture. Never imported by the app.
const { createHash } = require('node:crypto');
const { existsSync, realpathSync, statSync } = require('node:fs');
const { join } = require('node:path');

function installRecoveryTrace() {
  const snapshot = () => ({
    notices: [...document.querySelectorAll('[data-project-unavailable]')].map(
      (node) => ({
        text: node.textContent.trim(),
        inert: !!node.closest('[inert]'),
        visible: !!node.getClientRects().length,
      }),
    ),
    rootInert: document.getElementById('root')?.inert ?? null,
    materialInert:
      document.querySelector('section[aria-label$="素材子画布"]')?.inert ??
      null,
    materialNodes: [
      ...document.querySelectorAll(
        'section[aria-label$="素材子画布"] .react-flow__node-material',
      ),
    ].map((node) => node.dataset.id),
    buttons: [...document.querySelectorAll('button')]
      .slice(0, 80)
      .map((button) => ({
        text: button.textContent.trim().slice(0, 200),
        label: button.getAttribute('aria-label'),
        disabled: button.disabled,
        inert: !!button.closest('[inert]'),
        visible: !!button.getClientRects().length,
      })),
    alerts: [...document.querySelectorAll('[role="alert"]')].map((node) =>
      node.textContent.trim().slice(0, 2000),
    ),
    statuses: [...document.querySelectorAll('[role="status"]')].map((node) =>
      node.textContent.trim().slice(0, 1000),
    ),
    dialogs: [...document.querySelectorAll('dialog[open]')].map(
      (node) => node.querySelector('h2')?.textContent,
    ),
    progress: window.referenceProgress ?? null,
    unavailableAt: window.referenceUnavailableAt ?? null,
  });
  const trace = [];
  let last = '';
  const record = (label) => {
    const state = snapshot();
    const encoded = JSON.stringify(state);
    if (label === 'mutation' && encoded === last) return;
    last = encoded;
    const entry = { label, at: new Date().toISOString(), state };
    trace.push(entry);
    if (trace.length > 64) trace.splice(1, 1);
    console.log(`REFERENCE_RECOVERY_UI:${JSON.stringify(entry)}`);
  };
  window.referenceRecoveryDiagnostics = { snapshot, trace, record };
  const observer = new MutationObserver(() => {
    if (trace.length) record('mutation');
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'inert', 'aria-busy'],
  });
  document.addEventListener(
    'click',
    (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('button')?.textContent.trim() === '重试读取项目'
      )
        record('retry-click-capture');
    },
    { capture: true },
  );
}

function fingerprint(value) {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest('hex');
}
function workspace(value) {
  if (!value) return null;
  return {
    revision: value.revision,
    sha256: fingerprint(value),
    shots: value.shots.map((shot) => ({
      id: shot.id,
      nodes: shot.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        assetId: node.assetId,
      })),
      groups: shot.groups.map((group) => group.id),
    })),
  };
}
function fileState(file) {
  if (!file) return null;
  if (!existsSync(file)) return { file, exists: false };
  const info = statSync(file);
  return {
    file,
    exists: true,
    realpath: realpathSync.native(file),
    size: info.size,
  };
}

async function readRecoveryDiagnostic(
  run,
  { base, projectId, database, backup },
) {
  // Bounds only diagnostic reads; never changes a workflow assertion or wait deadline.
  const read = async (code) => {
    let timer;
    try {
      return await Promise.race([
        run(code),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Diagnostic read timed out')),
            2000,
          );
        }),
      ]);
    } catch (error) {
      return { diagnosticError: String(error) };
    } finally {
      clearTimeout(timer);
    }
  };
  const library = await read('window.desktop.getLibrary()');
  if (library.root !== join(base, 'projects'))
    return {
      diagnosticError:
        'Fixture library identity unavailable or changed; refusing to record page or library contents',
      readError: library.diagnosticError,
    };
  const key = JSON.stringify(projectId);
  const [ui, project, generation, drafts, recovery] = await Promise.all([
    read(
      `window.referenceRecoveryDiagnostics ? {current:window.referenceRecoveryDiagnostics.snapshot(),trace:window.referenceRecoveryDiagnostics.trace} : {notInstalled:true}`,
    ),
    projectId ? read(`window.desktop.openProject(${key})`) : null,
    projectId ? read(`window.desktop.getGenerationWorkspace(${key})`) : null,
    projectId ? read(`window.desktop.listWorkspaceDrafts(${key})`) : null,
    projectId ? read(`window.desktop.readProjectRecovery(${key})`) : null,
  ]);
  return {
    ui,
    files: { database: fileState(database), backup: fileState(backup) },
    library: {
      writeBlocked: library.writeBlocked,
      migration: library.migration,
      jobs: library.jobs
        .filter((job) => job.projectId === projectId)
        .map(({ id, name, status, size, sha256, error }) => ({
          id,
          name,
          status,
          size,
          sha256,
          error,
        })),
    },
    project: project?.diagnosticError
      ? project
      : project && {
          id: project.project.id,
          canvasRevision: project.canvas.revision,
          canvasSha256: fingerprint(project.canvas),
          assets: project.assets.map(({ id, relativePath, size, sha256 }) => ({
            id,
            relativePath,
            size,
            sha256,
          })),
        },
    recovery: recovery?.diagnosticError
      ? recovery
      : recovery && {
          canvasSha256: fingerprint(recovery.snapshot.canvas),
          assetIds: recovery.snapshot.assets.map((asset) => asset.id),
          savedReferenceAssets: recovery.savedReferenceAssets,
        },
    generation: generation?.diagnosticError
      ? generation
      : workspace(generation),
    drafts: drafts?.diagnosticError
      ? drafts
      : drafts && {
          issues: drafts.issues,
          drafts: drafts.drafts.map((draft) => ({
            sessionId: draft.sessionId,
            seq: draft.seq,
            saved: draft.saved,
            updatedAt: draft.updatedAt,
            baseline: workspace(draft.baseline),
            lastSubmitted: workspace(draft.lastSubmitted),
            workspace: workspace(draft.workspace),
          })),
        },
  };
}

module.exports = { installRecoveryTrace, readRecoveryDiagnostic };
