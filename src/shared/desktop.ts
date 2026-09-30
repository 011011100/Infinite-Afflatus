import type { CanvasPatch } from './canvas/model';
import type { InteractionSettings } from './interaction/settings';
import type {
  LibraryState,
  MigrationPreview,
  ProjectSnapshot,
  Viewport,
} from './models';

export const IPC_CHANNELS = {
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
