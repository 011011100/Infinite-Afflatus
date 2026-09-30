import type { Asset } from '../models';

export const REFERENCE_EXTENSIONS = {
  image: ['jpg', 'jpeg', 'png', 'webp'],
  video: ['mp4', 'mov', 'webm', 'm4v'],
  audio: ['mp3', 'wav', 'm4a', 'ogg'],
  text: ['txt', 'md'],
} satisfies Record<Asset['kind'], string[]>;

export function referenceKind(extension: string): Asset['kind'] | null {
  for (const kind of ['image', 'video', 'audio', 'text'] as const) {
    if (REFERENCE_EXTENSIONS[kind].includes(extension.toLowerCase()))
      return kind;
  }
  return null;
}
