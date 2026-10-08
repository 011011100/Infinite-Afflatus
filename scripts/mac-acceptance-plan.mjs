import { isAbsolute } from 'node:path';

// Keep this list aligned with run-fixtures.mjs. The Node-only coverage test
// deliberately fails when a fixture or workflow production check is omitted.
export const rendererScenarios = [
  'xyflow-lifecycle',
  'canvas-recovery',
  'media-tool-settings-controls',
  'reference-import-controls',
  'staging-cleanup-controls',
  'preview-cache-controls',
  'project-rename-controls',
  'trim-recovery-controls',
  'project-edit-recovery-controls',
  'app-backup-controls',
  'thumbnail-visibility-controls',
  'rescue-import-controls',
  'project-package-controls',
  'timeline-keyboard-controls',
  'material-keyboard-controls',
  'save-focus-controls',
  'material-search-controls',
  'shot-reuse-controls',
  'project-history-controls',
  'ark-generation-controls',
];

const productionChecks = [
  ['startup-recovery.cjs', false],
  ['root-relocation.mjs', false],
  ['draft-recovery.mjs', true],
  ['project-edit-recovery.mjs', true],
  ['rescue-import.mjs', false],
  ['app-backup-recovery.mjs', true],
  ['saved-staging-preservation.mjs', false],
  ['project-package-progress.mjs', false],
  ['material-keyboard-persistence.mjs', false],
  ['reference-import.cjs', false],
  ['reference-import-cancel.cjs', false],
  ['reference-import-unavailable.cjs', false],
  ['staging-cleanup.cjs', false],
  ['media-tool-settings-desktop.cjs', false],
  ['preview-cache-desktop.cjs', false],
];

export function parseMacAcceptanceArguments(args, env = {}) {
  const options = {
    planOnly: false,
    includeCode: false,
    realMedia: env.AFFLATUS_MEDIA_TESTS === '1',
    realDelivery: false,
    bundleDirectory: null,
  };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (flag === '--plan') options.planOnly = true;
    else if (flag === '--include-code') options.includeCode = true;
    else if (flag === '--real-media') options.realMedia = true;
    else if (flag === '--real-delivery') options.realDelivery = true;
    else if (flag === '--media-tools') {
      const value = args[++index];
      if (!value || !isAbsolute(value))
        throw new Error(
          '--media-tools requires an absolute local bundle directory',
        );
      options.bundleDirectory = value;
    } else throw new Error(`Unknown Mac acceptance option: ${flag}`);
  }
  return options;
}

export function createMacAcceptancePlan(options) {
  const stages = [];
  const add = (id, runner, args, dependsOn = [], extra = {}) =>
    stages.push({ id, runner, args, dependsOn, timeoutMs: 300_000, ...extra });
  add('preflight-code', 'preflight-code', [], [], { timeoutMs: 30_000 });
  add('preflight-electron', 'preflight-electron', [], [], {
    timeoutMs: 30_000,
  });
  for (const [id, args] of [
    ['code-check', ['check']],
    ['code-unit', ['test']],
    ['code-upgrade', ['test:upgrade']],
  ])
    add(id, 'pnpm', args, ['preflight-code'], {
      skipReason: options.includeCode
        ? null
        : 'Use --include-code to repeat cloud/static and upgrade checks.',
      timeoutMs: 600_000,
    });
  add('build', 'pnpm', ['build'], ['preflight-code'], {
    timeoutMs: 600_000,
  });
  for (const scenario of rendererScenarios)
    add(
      `renderer-${scenario}`,
      'node',
      ['--import', 'tsx', 'tests/browser/run-fixtures.mjs', scenario],
      ['preflight-code', 'preflight-electron'],
      { timeoutMs: 180_000 },
    );
  const desktopDependencies = ['build', 'preflight-electron'];
  for (const count of [100, 1000])
    add(
      `media-resources-${count}`,
      'node',
      [
        '--import',
        'tsx',
        'tests/browser/media-resource-profile.mjs',
        `--count=${count}`,
        `--label=mac${count}`,
        '--resource-limits',
      ],
      desktopDependencies,
    );
  for (const [file, tsx] of productionChecks)
    add(
      `desktop-${file.replace(/\.(?:cjs|mjs)$/, '')}`,
      'node',
      [...(tsx ? ['--import', 'tsx'] : []), `tests/browser/${file}`],
      desktopDependencies,
    );
  add(
    'media-diagnostics',
    'node',
    ['--import', 'tsx', 'scripts/check-media-tools.mjs'],
    ['preflight-code'],
  );
  add(
    'real-media-export',
    'node',
    ['--import', 'tsx', '--test', 'tests/export-media.test.ts'],
    ['preflight-code', 'media-diagnostics'],
    {
      realMedia: true,
      skipReason: options.realMedia
        ? null
        : 'Opt in with --real-media or AFFLATUS_MEDIA_TESTS=1; skipped is not FFmpeg acceptance.',
    },
  );
  add(
    'real-media-delivery',
    'electron',
    ['tests/browser/delivery.cjs'],
    [...desktopDependencies, 'media-diagnostics'],
    {
      skipReason: options.realDelivery
        ? null
        : 'Use --real-delivery for real FFmpeg production export and project-package delivery.',
    },
  );
  add(
    'package-directory',
    'node',
    [
      '--import',
      'tsx',
      'scripts/package-desktop.mjs',
      'dir',
      '--output',
      '<new-run-directory>/package',
      ...(options.bundleDirectory
        ? ['--media-tools', options.bundleDirectory]
        : []),
    ],
    desktopDependencies,
    {
      timeoutMs: 600_000,
    },
  );
  add('package-executable', 'resolve-package', [], ['package-directory']);
  add(
    'packaged-smoke',
    'node',
    [
      '--import',
      'tsx',
      'tests/browser/packaged-delivery.mjs',
      '<exact-newly-built-app-executable>',
    ],
    ['package-executable'],
  );
  return {
    schemaVersion: 1,
    scope:
      'Native macOS selected automated checks; manual and release acceptance remain separate.',
    options,
    stages,
    manual: [
      {
        id: 'B19-05',
        status: 'manual',
        detail:
          'Inspect real macOS ArrowLeft/tag-bubble and viewport evidence in material-keyboard-controls; a batch result alone does not close the existing issue.',
      },
      {
        id: 'B19-06',
        status: 'manual',
        detail:
          'Inspect native activation/focus in material-keyboard-persistence; report which internal phases actually executed.',
      },
      {
        id: 'chinese-ime',
        status: 'manual',
        detail:
          'Use an actual Chinese IME for composition, candidate selection, Enter/Escape, shortcuts, focus restoration, native close and failed-save retry.',
      },
      {
        id: 'staged-reference-desktop',
        status: 'manual',
        detail:
          'Check completely received but unsaved image/video/audio/text reads from isolated staging, Range/abort/lease release, concurrent save cleanup, project unavailable or migrating, save completion, reload and restart; Node-only staged-reference tests are not this desktop proof.',
      },
      {
        id: 'ark-integration',
        status: 'manual',
        detail:
          'The isolated ark-generation-controls renderer fixture is included; native credential storage/restart and production service/result adoption still need desktop evidence. China-region real Ark calls, credentials and cost approval remain separate; no live provider request is authorized by this runner.',
      },
      {
        id: 'preview-cache-native-gaps',
        status: 'manual',
        detail:
          'Verify overlapping native streams, reload/close, concurrent migration, case-sensitive/case-insensitive filesystems and large-project hash responsiveness; synthetic proxy tooling is not real transcoding.',
      },
      {
        id: 'target-platforms',
        status: 'manual',
        detail:
          'Record native OS version and architecture; other macOS versions/architectures and Windows remain unverified by this run.',
      },
      {
        id: 'release-package',
        status: 'manual',
        detail:
          'Installer, signing/notarization, Gatekeeper, install/overwrite/uninstall and historical installed-version upgrade are not run by directory packaging.',
      },
      {
        id: 'media-redistribution',
        status: 'manual',
        detail:
          'A supplied bundle must pass manifest/hash/target verification; binary provenance, applicable licenses/notices, codecs and redistribution approval still require review.',
      },
      {
        id: 'real-cloud',
        status: 'manual',
        detail:
          'Real Ark/Seedance/Seedream credentials, remote uploads, spending, endpoint/model availability and provider-result downloads require a separately authorized real-call acceptance.',
      },
    ],
  };
}

// Sequential by design. A failed peer does not block unrelated groups; only
// an explicit prerequisite can block a stage. Persist every transition.
export async function runAcceptanceStages({
  plan,
  execute,
  persist,
  signal,
  now = Date.now,
}) {
  const known = new Set();
  for (const stage of plan.stages) {
    if (known.has(stage.id) || stage.dependsOn.some((id) => !known.has(id)))
      throw new Error(`Invalid or forward stage dependency: ${stage.id}`);
    known.add(stage.id);
  }
  const report = {
    ...plan,
    startedAt: new Date(now()).toISOString(),
    status: 'running',
    acceptanceStatus: 'requires-manual-validation',
    stages: plan.stages.map((stage) => ({
      ...stage,
      status: 'pending',
      durationMs: 0,
    })),
  };
  await persist(report);
  for (const stage of report.stages) {
    const prerequisites = stage.dependsOn.filter(
      (id) => report.stages.find((item) => item.id === id)?.status !== 'passed',
    );
    if (stage.skipReason) {
      stage.status = 'skipped';
      stage.reason = stage.skipReason;
    } else if (signal?.aborted || prerequisites.length) {
      stage.status = 'blocked';
      stage.reason = signal?.aborted
        ? 'Batch interrupted before this stage executed.'
        : `Prerequisites did not pass: ${prerequisites.join(', ')}`;
    } else {
      stage.status = 'running';
      const start = now();
      stage.startedAt = new Date(start).toISOString();
      await persist(report);
      try {
        const outcome = await execute(stage, signal);
        if (
          !['passed', 'failed', 'blocked', 'timed-out', 'interrupted'].includes(
            outcome.status,
          )
        )
          throw new Error(`Invalid execution result for ${stage.id}`);
        Object.assign(stage, outcome);
      } catch (error) {
        stage.status = signal?.aborted ? 'interrupted' : 'failed';
        stage.reason = error instanceof Error ? error.message : String(error);
      }
      stage.durationMs = Math.max(0, now() - start);
      stage.finishedAt = new Date(now()).toISOString();
    }
    await persist(report);
  }
  report.finishedAt = new Date(now()).toISOString();
  report.durationMs = Math.max(0, now() - Date.parse(report.startedAt));
  report.status = signal?.aborted
    ? 'interrupted'
    : report.stages.some((stage) =>
          ['failed', 'timed-out', 'interrupted'].includes(stage.status),
        )
      ? 'failed'
      : report.stages.some((stage) => stage.status === 'blocked')
        ? 'blocked'
        : 'completed';
  report.automatedStatus =
    report.status === 'completed' ? 'passed' : report.status;
  await persist(report);
  return report;
}
