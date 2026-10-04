/** Portable editable-project archive, distinct from an exported video. */
export interface ProjectPackageInfo {
  projectId: string;
  name: string;
  assetCount: number;
  /** Estimated uncompressed database and managed-media bytes. */
  bytes: number;
}

export interface ProjectPackageExport extends ProjectPackageInfo {
  path: string;
}
