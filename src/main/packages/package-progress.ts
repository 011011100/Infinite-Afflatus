import type { ProjectPackageProgress } from '../../shared/project-package';

export type PackageProgress = Omit<
  ProjectPackageProgress,
  'requestId' | 'projectId' | 'operation'
>;
export interface ProjectPackageControls {
  signal?: AbortSignal;
  onProgress?: (progress: PackageProgress) => void;
}
export class PackageCancelledError extends Error {
  constructor() {
    super('项目包操作已取消');
    this.name = 'PackageCancelledError';
  }
}

/** Subscriber failures cannot change an operation's durable outcome. */
export class PackageProgressReporter {
  private state: PackageProgress = {
    phase: 'waiting',
    completedBytes: 0,
    totalBytes: null,
    completedFiles: 0,
    totalFiles: null,
    fileName: null,
    canCancel: true,
  };
  constructor(private listener?: ProjectPackageControls['onProgress']) {}
  update(change: Partial<PackageProgress>) {
    this.state = { ...this.state, ...change };
    try {
      this.listener?.({ ...this.state });
    } catch {
      /* UI observer may have been destroyed. */
    }
  }
  start(totalBytes: number, totalFiles: number) {
    this.update({ phase: 'copying', totalBytes, totalFiles });
  }
  file(fileName: string) {
    this.update({ phase: 'copying', fileName });
  }
  written(bytes: number) {
    this.update({ completedBytes: this.state.completedBytes + bytes });
  }
  verified() {
    this.update({ completedFiles: this.state.completedFiles + 1 });
  }
}
