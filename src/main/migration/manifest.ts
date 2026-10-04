import { lstat } from 'node:fs/promises';
import type { MigrationStatus } from '../../shared/models';
import { readProxies } from '../projects/project-database';
import type { ProjectService } from '../projects/project-service';
import {
  type Fingerprint,
  fingerprint,
  safeFile,
  sameContent,
} from '../storage/files';

export interface DirectoryIdentity {
  device: number;
  inode: number;
}
export interface ManagedFile {
  projectId: string;
  relativePath: string;
  source: Fingerprint;
  copied: Fingerprint | null;
  cleaned: boolean;
}
export interface MigrationJournal {
  status: MigrationStatus;
  switched: boolean;
  sourceIdentity: DirectoryIdentity;
  targetIdentity: DirectoryIdentity;
  files: ManagedFile[];
  sourceDirectories: Record<string, DirectoryIdentity>;
  targetDirectories: Record<string, DirectoryIdentity>;
}

export async function directoryIdentity(
  path: string,
): Promise<DirectoryIdentity> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('目录已变化或包含符号链接');
  return { device: stat.dev, inode: stat.ino };
}

export function sameDirectory(
  a: DirectoryIdentity,
  b: DirectoryIdentity,
): boolean {
  return a.device === b.device && a.inode === b.inode;
}

export async function buildManifest(
  root: string,
  projects: ProjectService,
  ids: string[],
): Promise<ManagedFile[]> {
  const files: ManagedFile[] = [];
  for (const id of ids) {
    const snapshot = await projects.open(id);
    const entries = [
      { relativePath: 'project.sqlite', expected: null },
      ...snapshot.assets.map((asset) => ({
        relativePath: asset.relativePath,
        expected: asset,
      })),
      ...readProxies(await projects.databasePath(id), projects.summary(id)).map(
        (proxy) => ({
          relativePath: proxy.relativePath,
          expected: proxy,
        }),
      ),
    ];
    for (const entry of entries) {
      const relativePath = `${snapshot.project.folder}/${entry.relativePath}`;
      const derived = entry.expected && 'sourceHash' in entry.expected;
      let source: Fingerprint;
      try {
        source = await fingerprint(await safeFile(root, relativePath));
        if (entry.expected && !sameContent(source, entry.expected))
          throw new Error(`素材已变化：${entry.relativePath}`);
      } catch (error) {
        // Missing/replaced derived files are rebuilt later; do not adopt or delete replacements.
        if (derived) continue;
        throw error;
      }
      files.push({
        projectId: id,
        relativePath,
        source,
        copied: null,
        cleaned: false,
      });
    }
  }
  return files;
}
