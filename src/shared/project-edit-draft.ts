import { type CanvasCard, sameCard } from './canvas/model';
import type { Asset, ProjectSnapshot, ProjectSummary } from './models';

export interface ProjectEditDraftKey {
  sessionId: string;
  seq: number;
}

export interface NameEditDraftInput extends ProjectEditDraftKey {
  kind: 'name';
  baseline: string;
  /** Raw input, including an empty field. Only an explicit save validates a name. */
  target: string;
  lastSubmitted?: string;
}

export interface TrimEditDraftInput extends ProjectEditDraftKey {
  kind: 'trim';
  baseline: CanvasCard;
  target: CanvasCard;
  lastSubmitted?: CanvasCard;
  /** Complete source records in the card's explicit playback order. */
  assets: Asset[];
}

export type ProjectEditDraftInput = NameEditDraftInput | TrimEditDraftInput;

export type ProjectEditDraftRecord = ProjectEditDraftInput & {
  format: 'infinite-afflatus-project-edit-draft';
  version: 1;
  project: Pick<ProjectSummary, 'id' | 'folder' | 'name'>;
  updatedAt: string;
};

export interface ProjectEditDraftList {
  drafts: ProjectEditDraftRecord[];
  issues: { file: string; message: string }[];
}

export type ProjectEditDraftExport =
  | ProjectEditDraftKey
  | { snapshot: ProjectEditDraftInput };

export type ProjectEditDraftState =
  | 'matching'
  | 'submitted'
  | 'matching-submission'
  | 'conflict';

/** A stable ID alone cannot authorize applying an old trim to changed source metadata. */
export function sameDraftAssets(expected: Asset[], current: Asset[]): boolean {
  const indexed = new Map(current.map((asset) => [asset.id, asset]));
  if (
    indexed.size !== current.length ||
    new Set(expected.map((asset) => asset.id)).size !== expected.length
  )
    return false;
  return expected.every((asset) => {
    const actual = indexed.get(asset.id);
    return (
      !!actual &&
      actual.name === asset.name &&
      actual.relativePath === asset.relativePath &&
      actual.size === asset.size &&
      actual.sha256 === asset.sha256 &&
      actual.kind === asset.kind &&
      actual.usage === asset.usage
    );
  });
}

/** Recovery changes only the named field/card; unrelated saved work remains intact. */
export function projectEditDraftState(
  draft: ProjectEditDraftInput,
  current: ProjectSnapshot,
): ProjectEditDraftState {
  if (draft.kind === 'name') {
    const name = current.project.name;
    if (draft.target.trim() === name) return 'submitted';
    if (draft.lastSubmitted !== undefined && name === draft.lastSubmitted)
      return 'matching-submission';
    return name === draft.baseline ? 'matching' : 'conflict';
  }
  const card = current.canvas.cards.find(
    (item) => item.id === draft.baseline.id,
  );
  if (!card || !sameDraftAssets(draft.assets, current.assets))
    return 'conflict';
  if (sameCard(card, draft.target)) return 'submitted';
  if (draft.lastSubmitted && sameCard(card, draft.lastSubmitted))
    return 'matching-submission';
  return sameCard(card, draft.baseline) ? 'matching' : 'conflict';
}
