import type { ProjectSummary } from './models';
import type {
  ProjectEditDraftKey,
  ProjectEditDraftState,
} from './project-edit-draft';

export type RescueImportKind = 'workspace' | 'name' | 'trim';

/** A preview authorizes adding a recovery copy, never applying it to the project. */
export interface RescueImportPreview {
  token: string;
  expiresAt: string;
  kind: RescueImportKind;
  sourceName: string;
  sourceBytes: number;
  project: Pick<ProjectSummary, 'id' | 'folder' | 'name'>;
  updatedAt: string;
  state: ProjectEditDraftState;
  referenceCount: number;
  shotCount: number;
  nameTarget: string | null;
  nameBaseline: string | null;
  cardId: string | null;
}

export interface RescueImportResult {
  projectId: string;
  kind: RescueImportKind;
  key: ProjectEditDraftKey;
  duplicate: boolean;
}
