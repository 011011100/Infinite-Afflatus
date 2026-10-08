/** Supplied provenance is recorded for review; it is not a redistribution-rights determination. */
export interface MediaToolBundleFile {
  file: string;
  sha256: string;
}
export interface MediaToolBundleManifest {
  version: 1;
  target: {
    platform: 'darwin' | 'win32';
    arch: 'x64' | 'arm64';
  };
  build: { version: string; source: string };
  license: string;
  tools: { ffmpeg: MediaToolBundleFile; ffprobe: MediaToolBundleFile };
  notices: MediaToolBundleFile[];
}
