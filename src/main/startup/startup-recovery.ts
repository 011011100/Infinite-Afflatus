export type StartupRecoveryAction =
  | 'retry'
  | 'show-data'
  | 'show-projects'
  | 'quit';

/** Location viewing cannot retry or mutate storage; only the explicit retry action opens again. */
export async function runStartupRecovery<T>(
  open: () => Promise<T>,
  choose: (
    failure: unknown,
    locationError: string | null,
  ) => Promise<StartupRecoveryAction>,
  reveal: (
    action: 'show-data' | 'show-projects',
    failure: unknown,
  ) => Promise<void>,
): Promise<T | null> {
  for (;;) {
    try {
      return await open();
    } catch (failure) {
      let locationError: string | null = null;
      for (;;) {
        const action = await choose(failure, locationError);
        if (action === 'quit') return null;
        if (action === 'retry') break;
        try {
          await reveal(action, failure);
          locationError = null;
        } catch (error) {
          locationError = `无法打开该位置：${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
  }
}
