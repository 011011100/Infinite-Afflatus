import type { GenerationWorkspace } from './generation/workspace';
import type { ProjectSummary } from './models';

export interface WorkspaceDraftInput {
  sessionId: string;
  seq: number;
  baseline: GenerationWorkspace;
  workspace: GenerationWorkspace;
  /** Exact expected result of the one serialized project write currently in flight. */
  lastSubmitted?: GenerationWorkspace;
}

export interface WorkspaceDraftRecord extends WorkspaceDraftInput {
  format: 'infinite-afflatus-workspace-draft';
  version: 1;
  project: Pick<ProjectSummary, 'id' | 'folder' | 'name'>;
  updatedAt: string;
  saved: boolean;
}

export interface WorkspaceDraftKey {
  sessionId: string;
  seq: number;
}

export type WorkspaceDraftExport =
  | WorkspaceDraftKey
  | { snapshot: WorkspaceDraftInput };

export interface WorkspaceDraftList {
  drafts: WorkspaceDraftRecord[];
  issues: { file: string; message: string }[];
}

/** Object key order is immaterial; array order, optional fields and revision are not. */
export function sameWorkspace(a: GenerationWorkspace, b: GenerationWorkspace) {
  const encode = (value: GenerationWorkspace) =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    );
  return encode(a) === encode(b);
}

export function submittedWorkspace(draft: WorkspaceDraftInput) {
  return { ...draft.workspace, revision: draft.baseline.revision + 1 };
}

export function workspaceDraftState(
  draft: WorkspaceDraftInput,
  current: GenerationWorkspace,
): 'matching' | 'submitted' | 'matching-submission' | 'conflict' {
  if (sameWorkspace(current, submittedWorkspace(draft))) return 'submitted';
  if (draft.lastSubmitted && sameWorkspace(current, draft.lastSubmitted))
    return 'matching-submission';
  return sameWorkspace(current, draft.baseline) ? 'matching' : 'conflict';
}
