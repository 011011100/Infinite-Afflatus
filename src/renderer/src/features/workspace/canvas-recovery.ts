import type { Asset, ProjectSnapshot } from '../../../../shared/models';

function sameAsset(a: Asset, b: Asset): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.relativePath === b.relativePath &&
    a.size === b.size &&
    a.sha256 === b.sha256 &&
    a.kind === b.kind &&
    a.usage === b.usage
  );
}

/** Only our acknowledged reference imports may extend the last displayed view. */
export function canResumeCanvas(
  confirmed: ProjectSnapshot,
  remote: ProjectSnapshot,
  savedReferenceAssets: Asset[] = [],
): boolean {
  if (
    remote.project.id !== confirmed.project.id ||
    remote.project.folder !== confirmed.project.folder ||
    JSON.stringify(remote.canvas) !== JSON.stringify(confirmed.canvas) ||
    JSON.stringify(remote.assets.slice(0, confirmed.assets.length)) !==
      JSON.stringify(confirmed.assets)
  )
    return false;

  const saved = new Map(savedReferenceAssets.map((asset) => [asset.id, asset]));
  const current = new Map(remote.assets.map((asset) => [asset.id, asset]));
  if (
    current.size !== remote.assets.length ||
    saved.size !== savedReferenceAssets.length
  )
    return false;

  // Checking only additions could accept an old database that contains one of
  // two completed imports. Every known acknowledgement must still be present.
  for (const asset of savedReferenceAssets) {
    const value = current.get(asset.id);
    if (asset.usage !== 'reference' || !value || !sameAsset(asset, value))
      return false;
  }
  for (const asset of remote.assets.slice(confirmed.assets.length)) {
    const acknowledged = saved.get(asset.id);
    if (!acknowledged || !sameAsset(asset, acknowledged)) return false;
  }
  return true;
}
