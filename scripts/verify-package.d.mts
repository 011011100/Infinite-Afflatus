import type { MediaToolBundleManifest } from '../src/shared/media-tool-bundle';
export interface PackageVerification {
  asar: string;
  files: number;
  mediaTools?: {
    directory: string;
    manifest: MediaToolBundleManifest;
    files: number;
  };
}
export function verifyAsar(
  archive: string,
  reader?: Pick<
    typeof import('@electron/asar'),
    'listPackage' | 'statFile' | 'extractFile'
  >,
): PackageVerification;
export function verifyPackagedApp(
  appOutDir: string,
  options?: {
    platform?: NodeJS.Platform;
    arch?: string;
    productName?: string;
    requireMediaTools?: boolean;
    expectedMediaToolManifest?: MediaToolBundleManifest;
  },
): Promise<PackageVerification>;
