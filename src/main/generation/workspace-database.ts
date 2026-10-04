import type { DatabaseSync } from 'node:sqlite';
import {
  emptyGenerationDraft,
  validateGenerationDraft,
} from '../../shared/generation/draft';
import type { GenerationWorkspace } from '../../shared/generation/workspace';
import {
  validateWorkspace,
  workspaceFromDraft,
} from '../../shared/generation/workspace';
import type { ProjectSummary } from '../../shared/models';
import { withProject } from '../projects/project-database';
import type { ProjectIdentity } from '../projects/project-guard';

function read(db: DatabaseSync): GenerationWorkspace {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = 'generation-workspace'")
    .get();
  if (row) return validateWorkspace(JSON.parse(String(row.value)));
  const legacy = db
    .prepare("SELECT value FROM metadata WHERE key = 'generation-draft'")
    .get();
  const project = JSON.parse(
    String(
      db.prepare("SELECT value FROM metadata WHERE key = 'project'").get()
        ?.value,
    ),
  ) as ProjectSummary;
  return workspaceFromDraft(
    project.id,
    legacy
      ? validateGenerationDraft(JSON.parse(String(legacy.value)))
      : emptyGenerationDraft(),
  );
}
export function readWorkspace(file: string, expected?: ProjectIdentity) {
  return withProject(file, false, read, expected);
}
export function writeWorkspace(
  file: string,
  workspace: GenerationWorkspace,
  expected: ProjectIdentity,
) {
  return withProject(
    file,
    true,
    (db) => {
      if (read(db).revision !== workspace.revision)
        throw new Error('素材画布已在其他窗口修改，请重新打开项目');
      const saved = { ...workspace, revision: workspace.revision + 1 };
      const project = JSON.parse(
        String(
          db.prepare("SELECT value FROM metadata WHERE key = 'project'").get()
            ?.value,
        ),
      ) as ProjectSummary;
      project.updatedAt = new Date().toISOString();
      const put = db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)');
      put.run('generation-workspace', JSON.stringify(saved));
      put.run('project', JSON.stringify(project));
      return { workspace: saved, project };
    },
    expected,
  );
}
