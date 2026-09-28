export const IPC_CHANNELS = {
  appInfo: 'app:info',
} as const;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

/** Only specific desktop capabilities cross the preload boundary. */
export interface DesktopBridge {
  getAppInfo: () => Promise<AppInfo>;
}
