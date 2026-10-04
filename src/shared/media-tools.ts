export type MediaToolName = 'ffmpeg' | 'ffprobe';
export interface MediaToolLocation {
  name: MediaToolName;
  command: string;
  source: 'environment' | 'path' | 'standard-location';
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
