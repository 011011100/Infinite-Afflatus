export function message(reason: unknown): string {
  return (reason instanceof Error ? reason.message : String(reason)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
}
