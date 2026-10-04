export const APP_NAME: 'Infinite Afflatus';
export const APP_ID: 'com.infiniteafflatus.desktop';
export function allowedApplicationFile(path: string): boolean;
export function checkApplicationFiles(
  files: string[],
  read: (file: string) => string,
): void;
export function stageApplication(
  root: string,
  destination: string,
): Promise<string[]>;
