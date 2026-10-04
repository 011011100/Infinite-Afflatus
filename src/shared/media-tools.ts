export type MediaToolName = 'ffmpeg' | 'ffprobe';
export interface MediaToolLocation {
  name: MediaToolName;
  command: string;
  source: 'environment' | 'saved' | 'path' | 'standard-location';
}
export type MediaToolPair = Readonly<
  Record<MediaToolName, Readonly<MediaToolLocation>>
>;
export interface MediaToolPaths {
  ffmpeg: string | null;
  ffprobe: string | null;
}
export interface MediaToolSettingsState {
  /** Null means invalid or newer stored settings; never silently replace them. */
  paths: MediaToolPaths | null;
  locations: MediaToolPair;
  error: string | null;
}
export type MediaToolStatus =
  | 'available'
  | 'missing'
  | 'permission-denied'
  | 'timeout'
  | 'invalid'
  | 'failed';
export interface MediaToolResult extends MediaToolLocation {
  status: MediaToolStatus;
  version: string | null;
  detail: string | null;
}
export interface MediaToolsReport {
  checkedAt: string;
  tools: MediaToolResult[];
}
export interface MediaToolSettingsChange {
  settings: MediaToolSettingsState;
  /** A single-tool change reports that tool; a full check reports both. */
  report: MediaToolsReport;
}
