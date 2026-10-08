import type { DesktopBridge } from '../../../../shared/desktop';
import type { GenerationWorkspace } from '../../../../shared/generation/workspace';
import { sameWorkspace } from '../../../../shared/workspace-draft';

/** A lost receipt is successful only when a read proves this exact single write. */
export async function saveWorkspaceSubmission(
  bridge: Pick<
    DesktopBridge,
    'saveGenerationWorkspace' | 'getGenerationWorkspace'
  >,
  projectId: string,
  submitted: GenerationWorkspace,
): Promise<GenerationWorkspace> {
  const expected = structuredClone({
    ...submitted,
    revision: submitted.revision + 1,
  });
  try {
    return await bridge.saveGenerationWorkspace(projectId, submitted);
  } catch (error) {
    try {
      const current = await bridge.getGenerationWorkspace(projectId);
      if (sameWorkspace(current, expected)) return current;
    } catch {
      // Preserve the original save failure; an unavailable read cannot confirm it.
    }
    throw error;
  }
}
