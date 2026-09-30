import type { Fingerprint } from '../storage/files';

export interface ProxyRecord extends Fingerprint {
  assetId: string;
  sourceHash: string;
  version: number;
  relativePath: string;
}
