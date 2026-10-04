export interface PackageVerification {
  asar: string;
  files: number;
}
export function verifyAsar(archive: string): PackageVerification;
export function verifyPackagedApp(
  appOutDir: string,
  options?: { platform?: string; productName?: string },
): Promise<PackageVerification>;
