import type { CanvasPatch } from './canvas/model';
import type { SequenceExportJob, SequenceExportOptions } from './export';
import type {
  GenerationDraft,
  ReferenceImportResult,
} from './generation/draft';
import type { GenerationWorkspace } from './generation/workspace';
import type { InteractionSettings } from './interaction/settings';
import type {
  LibraryState,
  MigrationPreview,
  ProjectSnapshot,
  Viewport,
} from './models';
import type { ProjectPackageInfo } from './project-package';

export const IPC_CHANNELS = {
  cancelProjectPackage: 'package:cancel',
  saveBeforeLeave: 'lifecycle:save-before-leave',
  saveBeforeLeaveResult: 'lifecycle:save-before-leave-result',
  leaveCancelled: 'lifecycle:leave-cancelled',
  inspectProjectPackage: 'package:inspect',
  exportProjectPackage: 'package:export',
  importProjectPackage: 'package:import',
  duplicateProject: 'project:duplicate',
  startExport: 'export:start',
  listExports: 'export:list',
  cancelExport: 'export:cancel',
  revealExport: 'export:reveal',
  exportsChanged: 'export:changed',
  getGenerationWorkspace: 'generation:workspace',
  saveGenerationWorkspace: 'generation:save-workspace',
  getGenerationDraft: 'generation:draft',
  saveGenerationDraft: 'generation:save-draft',
  importReferences: 'generation:import-references',
  readReferenceText: 'generation:read-text',
  appInfo: 'app:info',
  saveInteractions: 'settings:interactions',
  state: 'library:state',
  changed: 'library:changed',
  createProject: 'project:create',
  openProject: 'project:open',
  renameProject: 'project:rename',
  saveViewport: 'project:viewport',
  patchCanvas: 'project:canvas-patch',
  importVideos: 'project:import-videos',
  prepareProxy: 'media:prepare-proxy',
  chooseDirectory: 'storage:choose',
  startMigration: 'storage:migrate',
  cancelMigration: 'storage:cancel',
  retryCleanup: 'storage:cleanup',
  retrySave: 'save:retry',
  revealRoot: 'storage:reveal',
} as const;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

export interface ProxyResult {
  ready: boolean;
}

/** Only specific desktop capabilities cross the preload boundary. */
export interface DesktopBridge {
  cancelProjectPackage: () => Promise<void>;
  onSaveBeforeLeave: (listener: () => Promise<boolean>) => () => void;
  onLeaveCancelled: (listener: () => void) => () => void;
  inspectProjectPackage: (id: string) => Promise<ProjectPackageInfo>;
  exportProjectPackage: (id: string) => Promise<string | null>;
  importProjectPackage: () => Promise<ProjectSnapshot | null>;
  duplicateProject: (id: string) => Promise<ProjectSnapshot>;
  startExport: (
    projectId: string,
    cardId: string,
    options: SequenceExportOptions,
  ) => Promise<SequenceExportJob | null>;
  listExports: () => Promise<SequenceExportJob[]>;
  cancelExport: (id: string) => Promise<void>;
  revealExport: (id: string) => Promise<void>;
  onExportsChanged: (listener: () => void) => () => void;
  getGenerationWorkspace: (projectId: string) => Promise<GenerationWorkspace>;
  saveGenerationWorkspace: (
    projectId: string,
    workspace: GenerationWorkspace,
  ) => Promise<GenerationWorkspace>;
  getGenerationDraft: (projectId: string) => Promise<GenerationDraft>;
  saveGenerationDraft: (
    projectId: string,
    draft: GenerationDraft,
  ) => Promise<GenerationDraft>;
  importReferences: (projectId: string) => Promise<ReferenceImportResult>;
  readReferenceText: (projectId: string, assetId: string) => Promise<string>;
  getAppInfo: () => Promise<AppInfo>;
  saveInteractions: (settings: InteractionSettings) => Promise<void>;
  getLibrary: () => Promise<LibraryState>;
  onLibraryChanged: (listener: () => void) => () => void;
  createProject: (name: string) => Promise<ProjectSnapshot>;
  openProject: (id: string) => Promise<ProjectSnapshot>;
  renameProject: (id: string, name: string) => Promise<void>;
  saveViewport: (id: string, viewport: Viewport) => Promise<void>;
  patchCanvas: (id: string, patch: CanvasPatch) => Promise<ProjectSnapshot>;
  importVideos: (id: string) => Promise<void>;
  prepareProxy: (projectId: string, assetId: string) => Promise<ProxyResult>;
  chooseDirectory: () => Promise<MigrationPreview | null>;
  startMigration: (token: string) => Promise<void>;
  cancelMigration: () => Promise<void>;
  retryCleanup: () => Promise<void>;
  retrySave: (id: string) => Promise<void>;
  revealRoot: () => Promise<void>;
}
