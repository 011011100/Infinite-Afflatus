import type { Viewport } from '../models';
import type { GenerationParameters } from './draft';

export type Point = { x: number; y: number };
export type MaterialNode = {
  id: string;
  position: Point;
  groupId?: string;
  name?: string;
  width?: number;
  height?: number;
} & (
  | { type: 'text'; text: string }
  | { type: 'asset'; assetId: string; textOverride?: string }
);
export interface GenerationGroup {
  id: string;
  position: Point;
  width: number;
  height: number;
  parameters: GenerationParameters;
}
export interface CanvasLabel {
  id: string;
  position: Point;
  name: string;
  color: string;
  pinned: boolean;
}
export interface ShotWorkspace {
  id: string;
  name: string;
  /** Existing videos keep their shot materials when cards are split or joined. */
  sourceAssetId?: string;
  position: Point;
  viewport: Viewport;
  nodes: MaterialNode[];
  labels?: CanvasLabel[];
  groups: GenerationGroup[];
}
export interface GenerationWorkspace {
  version: 1;
  revision: number;
  shots: ShotWorkspace[];
}
export const MATERIAL_WIDTH = 260;
export const MATERIAL_HEIGHT = 244;
