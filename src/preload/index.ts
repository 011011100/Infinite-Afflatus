import { contextBridge, ipcRenderer } from 'electron';
import { type DesktopBridge, IPC_CHANNELS } from '../shared/desktop';

const desktop: DesktopBridge = {
  getArkConfig: () => ipcRenderer.invoke(IPC_CHANNELS.getArkConfig),
  saveArkConfig: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveArkConfig, input),
  previewArkGeneration: (target) =>
    ipcRenderer.invoke(IPC_CHANNELS.previewArkGeneration, target),
  submitArkGeneration: (token) =>
    ipcRenderer.invoke(IPC_CHANNELS.submitArkGeneration, token),
  cancelArkPreview: (token) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelArkPreview, token),
  listArkJobs: (projectId, shotId, groupId) =>
    ipcRenderer.invoke(IPC_CHANNELS.listArkJobs, projectId, shotId, groupId),
  refreshArkJob: (id) => ipcRenderer.invoke(IPC_CHANNELS.refreshArkJob, id),
  retryArkDownload: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.retryArkDownload, id),
  retryArkSave: (id) => ipcRenderer.invoke(IPC_CHANNELS.retryArkSave, id),
  stopArkPolling: (id) => ipcRenderer.invoke(IPC_CHANNELS.stopArkPolling, id),
  cancelArkQueued: (id) => ipcRenderer.invoke(IPC_CHANNELS.cancelArkQueued, id),
  adoptArkJob: (id, revision) =>
    ipcRenderer.invoke(IPC_CHANNELS.adoptArkJob, id, revision),
  onArkJobsChanged: (listener) => {
    const changed = () => listener();
    ipcRenderer.on(IPC_CHANNELS.arkJobsChanged, changed);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.arkJobsChanged, changed);
    };
  },
  chooseRescueImport: () => ipcRenderer.invoke(IPC_CHANNELS.chooseRescueImport),
  confirmRescueImport: (token) =>
    ipcRenderer.invoke(IPC_CHANNELS.confirmRescueImport, token),
  cancelRescueImport: () => ipcRenderer.invoke(IPC_CHANNELS.cancelRescueImport),
  getAppBackups: () => ipcRenderer.invoke(IPC_CHANNELS.getAppBackups),
  createAppBackup: () => ipcRenderer.invoke(IPC_CHANNELS.createAppBackup),
  revealAppBackups: () => ipcRenderer.invoke(IPC_CHANNELS.revealAppBackups),
  revealRetainedAppData: () =>
    ipcRenderer.invoke(IPC_CHANNELS.revealRetainedAppData),
  protectProjectEditDraft: (projectId, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.protectProjectEditDraft, projectId, input),
  listProjectEditDrafts: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.listProjectEditDrafts, projectId),
  acknowledgeProjectEditDraft: (projectId, key) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.acknowledgeProjectEditDraft,
      projectId,
      key,
    ),
  recoverProjectEditDraft: (projectId, key) =>
    ipcRenderer.invoke(IPC_CHANNELS.recoverProjectEditDraft, projectId, key),
  discardProjectEditDraft: (projectId, key) =>
    ipcRenderer.invoke(IPC_CHANNELS.discardProjectEditDraft, projectId, key),
  exportProjectEditDraft: (projectId, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.exportProjectEditDraft, projectId, input),
  protectWorkspaceDraft: (projectId, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.protectWorkspaceDraft, projectId, input),
  listWorkspaceDrafts: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.listWorkspaceDrafts, projectId),
  acknowledgeWorkspaceDraft: (projectId, key) =>
    ipcRenderer.invoke(IPC_CHANNELS.acknowledgeWorkspaceDraft, projectId, key),
  recoverWorkspaceDraft: (projectId, key) =>
    ipcRenderer.invoke(IPC_CHANNELS.recoverWorkspaceDraft, projectId, key),
  exportWorkspaceDraft: (projectId, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.exportWorkspaceDraft, projectId, input),
  checkMediaTools: () => ipcRenderer.invoke(IPC_CHANNELS.checkMediaTools),
  getMediaToolSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getMediaToolSettings),
  chooseMediaTool: (name) =>
    ipcRenderer.invoke(IPC_CHANNELS.chooseMediaTool, name),
  resetMediaTool: (name) =>
    ipcRenderer.invoke(IPC_CHANNELS.resetMediaTool, name),
  scanProjectHealth: (projectId, mode) =>
    ipcRenderer.invoke(IPC_CHANNELS.scanProjectHealth, projectId, mode),
  restoreMissingAsset: (projectId, assetId) =>
    ipcRenderer.invoke(IPC_CHANNELS.restoreMissingAsset, projectId, assetId),
  cancelProjectHealth: () =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelProjectHealth),
  onProjectHealthProgress: (listener) => {
    const changed = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<typeof listener>[0],
    ) => listener(state);
    ipcRenderer.on(IPC_CHANNELS.projectHealthProgress, changed);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.projectHealthProgress, changed);
    };
  },
  cancelProjectPackage: (requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelProjectPackage, requestId),
  onProjectPackageProgress: (listener) => {
    const progress = (
      _event: Electron.IpcRendererEvent,
      value: Parameters<typeof listener>[0],
    ) => listener(value);
    ipcRenderer.on(IPC_CHANNELS.projectPackageProgress, progress);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.projectPackageProgress, progress);
    };
  },
  preparePackageOperationsForLeave: () =>
    ipcRenderer.invoke(IPC_CHANNELS.preparePackageOperationsForLeave),
  resumePackageOperations: (token) =>
    ipcRenderer.invoke(IPC_CHANNELS.resumePackageOperations, token),
  onLeaveCancelled: (listener) => {
    const cancel = () => listener();
    ipcRenderer.on(IPC_CHANNELS.leaveCancelled, cancel);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.leaveCancelled, cancel);
    };
  },
  onSaveBeforeLeave: (listener) => {
    const request = (_event: Electron.IpcRendererEvent, token: string) => {
      void Promise.resolve()
        .then(listener)
        .catch(() => false)
        .then((saved) =>
          ipcRenderer.invoke(IPC_CHANNELS.saveBeforeLeaveResult, token, saved),
        )
        .catch(() => {
          /* A timeout or destroyed window never authorizes a later close. */
        });
    };
    ipcRenderer.on(IPC_CHANNELS.saveBeforeLeave, request);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.saveBeforeLeave, request);
    };
  },
  inspectProjectPackage: (id, requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.inspectProjectPackage, id, requestId),
  exportProjectPackage: (id, requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.exportProjectPackage, id, requestId),
  importProjectPackage: (requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.importProjectPackage, requestId),
  duplicateProject: (id, requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.duplicateProject, id, requestId),
  startExport: (projectId, cardId, options) =>
    ipcRenderer.invoke(IPC_CHANNELS.startExport, projectId, cardId, options),
  listExports: () => ipcRenderer.invoke(IPC_CHANNELS.listExports),
  cancelExport: (id) => ipcRenderer.invoke(IPC_CHANNELS.cancelExport, id),
  cancelExportPreparation: () =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelExportPreparation),
  revealExport: (id) => ipcRenderer.invoke(IPC_CHANNELS.revealExport, id),
  onExportsChanged: (listener) => {
    const changed = () => listener();
    ipcRenderer.on(IPC_CHANNELS.exportsChanged, changed);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.exportsChanged, changed);
  },
  getGenerationWorkspace: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.getGenerationWorkspace, id),
  saveGenerationWorkspace: (id, workspace) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveGenerationWorkspace, id, workspace),
  getGenerationDraft: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.getGenerationDraft, id),
  saveGenerationDraft: (id, draft) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveGenerationDraft, id, draft),
  importReferences: (id, requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.importReferences, id, requestId),
  cancelReferenceImport: (requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelReferenceImport, requestId),
  onReferenceImportProgress: (listener) => {
    const progress = (
      _event: Electron.IpcRendererEvent,
      value: Parameters<typeof listener>[0],
    ) => listener(value);
    ipcRenderer.on(IPC_CHANNELS.referenceImportProgress, progress);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.referenceImportProgress,
        progress,
      );
    };
  },
  prepareReferenceImportsForLeave: () =>
    ipcRenderer.invoke(IPC_CHANNELS.prepareReferenceImportsForLeave),
  resumeReferenceSaves: (token) =>
    ipcRenderer.invoke(IPC_CHANNELS.resumeReferenceSaves, token),
  readReferenceText: (id, assetId) =>
    ipcRenderer.invoke(IPC_CHANNELS.readReferenceText, id, assetId),
  saveInteractions: (settings) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveInteractions, settings),
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
  getLibrary: () => ipcRenderer.invoke(IPC_CHANNELS.state),
  onLibraryChanged: (listener) => {
    const changed = () => listener();
    ipcRenderer.on(IPC_CHANNELS.changed, changed);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.changed, changed);
    };
  },
  createProject: (name) => ipcRenderer.invoke(IPC_CHANNELS.createProject, name),
  openProject: (id) => ipcRenderer.invoke(IPC_CHANNELS.openProject, id),
  readProjectRecovery: (id) =>
    ipcRenderer.invoke(IPC_CHANNELS.readProjectRecovery, id),
  renameProject: (id, name) =>
    ipcRenderer.invoke(IPC_CHANNELS.renameProject, id, name),
  saveViewport: (id, viewport) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveViewport, id, viewport),
  patchCanvas: (id, patch) =>
    ipcRenderer.invoke(IPC_CHANNELS.patchCanvas, id, patch),
  importVideos: (id) => ipcRenderer.invoke(IPC_CHANNELS.importVideos, id),
  prepareProxy: (projectId, assetId) =>
    ipcRenderer.invoke(IPC_CHANNELS.prepareProxy, projectId, assetId),
  acquireProxyUsage: (projectId, assetIds) =>
    ipcRenderer.invoke(IPC_CHANNELS.acquireProxyUsage, projectId, assetIds),
  releaseProxyUsage: (token) =>
    ipcRenderer.invoke(IPC_CHANNELS.releaseProxyUsage, token),
  inspectPreviewCache: () =>
    ipcRenderer.invoke(IPC_CHANNELS.inspectPreviewCache),
  previewCacheCleanup: () =>
    ipcRenderer.invoke(IPC_CHANNELS.previewCacheCleanup),
  executePreviewCacheCleanup: (token) =>
    ipcRenderer.invoke(IPC_CHANNELS.executePreviewCacheCleanup, token),
  cancelPreviewCacheOperations: () =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelPreviewCacheOperations),
  chooseDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseDirectory),
  startMigration: (token) =>
    ipcRenderer.invoke(IPC_CHANNELS.startMigration, token),
  cancelMigration: () => ipcRenderer.invoke(IPC_CHANNELS.cancelMigration),
  retryCleanup: () => ipcRenderer.invoke(IPC_CHANNELS.retryCleanup),
  retrySave: (id) => ipcRenderer.invoke(IPC_CHANNELS.retrySave, id),
  inspectStaging: () => ipcRenderer.invoke(IPC_CHANNELS.inspectStaging),
  previewStagingCleanup: () =>
    ipcRenderer.invoke(IPC_CHANNELS.previewStagingCleanup),
  executeStagingCleanup: (token) =>
    ipcRenderer.invoke(IPC_CHANNELS.executeStagingCleanup, token),
  cancelStagingOperations: () =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelStagingOperations),
  revealRoot: () => ipcRenderer.invoke(IPC_CHANNELS.revealRoot),
};

contextBridge.exposeInMainWorld('desktop', desktop);
