import type {
  MediaToolBundleTarget,
  VerifiedMediaToolBundle,
} from '../src/main/media/media-tool-bundle';
export function parsePackagingArguments(args: string[]): {
  mode: 'dir' | 'local';
  bundleDirectory: string | undefined;
  outputDirectory: string | undefined;
};
export function stageMediaToolBundle(
  source: string,
  destination: string,
  target: MediaToolBundleTarget,
): Promise<VerifiedMediaToolBundle>;
