import { validateGenerationDraft } from '../../shared/generation/draft';
import { imageInputError } from '../../shared/generation/image-generation';
import { validateWorkspace } from '../../shared/generation/workspace';
import type { Asset } from '../../shared/models';
import {
  readGenerationDraft,
  writeGenerationDraft,
} from '../projects/project-database';
import type { ProjectService } from '../projects/project-service';
import { ProjectReferenceReader } from '../saving/project-reference-reader';
import type { AppStore } from '../storage/app-store';
import type { WriteGate } from '../storage/write-gate';
import { readWorkspace, writeWorkspace } from './workspace-database';

export class GenerationService {
  constructor(
    private readonly projects: ProjectService,
    private readonly store: AppStore,
    private readonly gate: WriteGate,
    private readonly referenceReads = new ProjectReferenceReader(
      projects,
      store,
    ),
  ) {}

  async readWorkspace(projectId: string) {
    return readWorkspace(
      await this.projects.databasePath(projectId),
      this.projects.summary(projectId),
    );
  }

  async saveWorkspace(
    projectId: string,
    input: unknown,
    expectedBaseline?: unknown,
  ) {
    const workspace = validateWorkspace(input);
    const baseline =
      expectedBaseline === undefined
        ? undefined
        : validateWorkspace(expectedBaseline);
    return this.gate.run(async () => {
      const snapshot = await this.projects.open(projectId);
      const available = new Map<string, Asset['kind']>(
        snapshot.assets.map((asset) => [asset.id, asset.kind]),
      );
      for (const job of this.store.jobs()) {
        if (
          job.projectId === projectId &&
          job.usage === 'reference' &&
          job.sha256
        )
          available.set(job.id, job.kind);
      }
      const references = [...available].map(([id, kind]) => ({ id, kind }));
      for (const shot of workspace.shots) {
        if (
          shot.sourceAssetId &&
          !snapshot.assets.some(
            (asset) =>
              asset.id === shot.sourceAssetId && asset.kind === 'video',
          )
        )
          throw new Error('镜头视频不属于当前项目');
        if (
          shot.nodes.some(
            (node) => node.type === 'asset' && !available.has(node.assetId),
          )
        )
          throw new Error('素材不属于当前项目');
        for (const group of shot.groups) {
          if (group.kind !== 'image') continue;
          const error = imageInputError(
            shot.nodes.filter((node) => node.groupId === group.id),
            references,
          );
          if (error) throw new Error(error);
        }
      }
      const result = writeWorkspace(
        await this.projects.databasePath(projectId),
        workspace,
        this.projects.summary(projectId),
        baseline,
      );
      this.store.putProject(result.project);
      return result.workspace;
    });
  }

  async read(projectId: string) {
    return validateGenerationDraft(
      readGenerationDraft(
        await this.projects.databasePath(projectId),
        this.projects.summary(projectId),
      ),
    );
  }

  async save(projectId: string, input: unknown) {
    const draft = validateGenerationDraft(input);
    return this.gate.run(async () => {
      const snapshot = await this.projects.open(projectId);
      const available = new Set(snapshot.assets.map((asset) => asset.id));
      // Imported bytes may still be queued for saving. Their stable IDs survive migration.
      for (const job of this.store.jobs()) {
        if (
          job.projectId === projectId &&
          job.usage === 'reference' &&
          job.sha256
        )
          available.add(job.id);
      }
      if (draft.referenceIds.some((id) => !available.has(id)))
        throw new Error('参考素材不属于当前项目');
      const result = writeGenerationDraft(
        await this.projects.databasePath(projectId),
        draft,
        this.projects.summary(projectId),
      );
      this.store.putProject(result.project);
      return result.draft;
    });
  }

  async readText(projectId: string, assetId: string): Promise<string> {
    const media = await this.referenceReads.acquire(projectId, assetId, 'text');
    if (!media) throw new Error('文本素材不存在');
    try {
      if ((await media.handle.stat()).size > 1024 * 1024)
        throw new Error('文本素材不能超过 1 MB');
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(
          await media.handle.readFile(),
        );
      } catch {
        throw new Error(
          '无法读取文本，请使用 UTF-8 编码的 TXT 或 Markdown 文件',
        );
      }
    } finally {
      await media.handle.close();
    }
  }
}
