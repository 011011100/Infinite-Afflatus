import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateGenerationDraft } from '../../shared/generation/draft';
import {
  readGenerationDraft,
  writeGenerationDraft,
} from '../projects/project-database';
import type { ProjectService } from '../projects/project-service';
import type { AppStore } from '../storage/app-store';
import { safeFile } from '../storage/files';
import type { WriteGate } from '../storage/write-gate';

export class GenerationService {
  constructor(
    private readonly projects: ProjectService,
    private readonly store: AppStore,
    private readonly gate: WriteGate,
  ) {}

  async read(projectId: string) {
    return validateGenerationDraft(
      readGenerationDraft(await this.projects.databasePath(projectId)),
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
      );
      this.store.putProject(result.project);
      return result.draft;
    });
  }

  async readText(projectId: string, assetId: string): Promise<string> {
    const snapshot = await this.projects.open(projectId);
    const asset = snapshot.assets.find(
      (item) => item.id === assetId && item.kind === 'text',
    );
    if (!asset) throw new Error('文本素材不存在');
    const path = await safeFile(
      dirname(await this.projects.databasePath(projectId)),
      asset.relativePath,
    );
    if ((await stat(path)).size > 1024 * 1024)
      throw new Error('文本素材不能超过 1 MB');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        await readFile(path),
      );
    } catch {
      throw new Error('无法读取文本，请使用 UTF-8 编码的 TXT 或 Markdown 文件');
    }
  }
}
