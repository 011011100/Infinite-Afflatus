export interface PackageVerification {
  asar: string;
  files: number;
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
  options?: { platform?: string; productName?: string },
): Promise<PackageVerification>;
