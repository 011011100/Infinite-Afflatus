import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SaveJob } from '../../shared/models';
import type { ProjectService } from '../projects/project-service';
import { validateAsset } from '../recovery/asset-inspection';
import { verifyFile } from '../recovery/verified-file';
import type { AppStore } from '../storage/app-store';
import { safeFile } from '../storage/files';
import {
  directoryIdentity,
  directoryIdentitySync,
  ordinaryFileState,
  ordinaryFileStateSync,
  sameFileIdentity,
  sameFileState,
} from './file-state';

/** Operation-local proof. Its final identity checks cannot yield before unlink. */
export interface SavedResultProof {
  recheck(): Promise<void>;
  assertCurrent(): void;
}
export type SavedResultVerifier = (
  job: SaveJob,
  signal?: AbortSignal,
) => Promise<SavedResultProof>;

const changed = () =>
  new Error('已保存素材或项目位置尚未确认，完整暂存副本已保留');

/** Project-aware authority for deleting a redundant, already-saved staging copy. */
export function savedResultVerifier(
  store: AppStore,
  projects: ProjectService,
): SavedResultVerifier {
  return async (job, signal) => {
    const expectedJob = JSON.stringify(job);
    const assertJob = () => {
      signal?.throwIfAborted();
      const current = store.job(job.id);
      if (current.status !== 'saved' || JSON.stringify(current) !== expectedJob)
        throw changed();
    };
    const context = async () => {
      assertJob();
      const root = store.root;
      const summary = projects.summary(job.projectId);
      const rootIdentity = await directoryIdentity(root);
      const database = await projects.databasePath(job.projectId);
      const directory = dirname(database);
      const projectIdentity = await directoryIdentity(directory);
      const databaseState = await ordinaryFileState(database);
      const snapshot = await projects.open(job.projectId);
      const asset = snapshot.assets.find((item) => item.id === job.id);
      if (!asset) throw changed();
      validateAsset(asset);
      if (
        asset.size !== job.size ||
        asset.sha256 !== job.sha256 ||
        asset.kind !== job.kind ||
        asset.usage !== job.usage ||
        (job.outputRelativePath &&
          asset.relativePath !== job.outputRelativePath)
      )
        throw changed();
      const target = await safeFile(directory, asset.relativePath);
      assertJob();
      if (
        store.root !== root ||
        projects.summary(job.projectId).folder !== summary.folder ||
        !sameFileIdentity(rootIdentity, await directoryIdentity(root)) ||
        !sameFileIdentity(
          projectIdentity,
          await directoryIdentity(directory),
        ) ||
        !sameFileState(databaseState, await ordinaryFileState(database))
      )
        throw changed();
      return {
        root,
        rootIdentity,
        database,
        databaseState,
        directory,
        projectIdentity,
        folder: summary.folder,
        asset: JSON.stringify(asset),
        target,
      };
    };

    const before = await context();
    const targetState = await ordinaryFileState(before.target);
    const content = await verifyFile(
      before.target,
      job.size,
      signal ?? new AbortController().signal,
      () => {},
    );
    if (
      content.size !== job.size ||
      content.sha256 !== job.sha256 ||
      !sameFileState(targetState, content.state) ||
      !sameFileState(targetState, await ordinaryFileState(before.target))
    )
      throw changed();

    return {
      async recheck() {
        const current = await context();
        if (
          current.root !== before.root ||
          current.database !== before.database ||
          current.directory !== before.directory ||
          current.folder !== before.folder ||
          current.asset !== before.asset ||
          current.target !== before.target ||
          !sameFileIdentity(current.rootIdentity, before.rootIdentity) ||
          !sameFileIdentity(current.projectIdentity, before.projectIdentity) ||
          !sameFileState(current.databaseState, before.databaseState) ||
          !sameFileState(targetState, await ordinaryFileState(current.target))
        )
          throw changed();
        assertJob();
      },
      assertCurrent() {
        assertJob();
        if (
          store.root !== before.root ||
          projects.summary(job.projectId).folder !== before.folder ||
          !sameFileIdentity(
            before.rootIdentity,
            directoryIdentitySync(before.root),
          ) ||
          !sameFileIdentity(
            before.projectIdentity,
            directoryIdentitySync(before.directory),
          ) ||
          realpathSync(before.database) !== resolve(before.database) ||
          !sameFileState(
            before.databaseState,
            ordinaryFileStateSync(before.database),
          ) ||
          realpathSync(before.target) !== resolve(before.target) ||
          !sameFileState(targetState, ordinaryFileStateSync(before.target))
        )
          throw changed();
      },
    };
  };
}
