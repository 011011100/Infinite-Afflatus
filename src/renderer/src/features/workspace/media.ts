export function mediaUrl(
  projectId: string,
  assetId: string,
  revision = 0,
): string {
  return `afflatus-media://asset/${projectId}/${assetId}${revision ? `?revision=${revision}` : ''}`;
}
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`;
}
