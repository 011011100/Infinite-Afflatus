// CDP timestamps describe real Chromium pipelines, independently of DOM counts.
export function summarizeNativeResources(rows, phases, observation) {
  const players = new Map();
  const processPeakKiB = {};
  const metrics = [];
  for (const row of rows) {
    if (row.kind === 'process-metrics') {
      metrics.push(row);
      for (const process of row.value)
        processPeakKiB[process.type] = Math.max(
          processPeakKiB[process.type] ?? 0,
          process.memory.workingSetSize,
        );
    }
    const id = row.value?.playerId;
    if (!id) continue;
    let player = players.get(id);
    if (!player) {
      player = { id, properties: {}, events: new Map() };
      players.set(id, player);
    }
    for (const property of row.value.properties ?? [])
      player.properties[property.name] = property.value;
    for (const event of row.value.events ?? [])
      player.events.set(`${event.timestamp}:${event.value}`, {
        time: event.timestamp,
        ...JSON.parse(event.value),
      });
  }
  const canvasEnd = phases.find(
    (phase) => phase.name === 'combination-return',
  )?.wallTime;
  const decodeIntervals = [];
  const decoderNames = {};
  const categorized = [];
  const sourceEvents =
    observation?.events.filter((event) => event.type === 'src') ?? [];
  for (const player of players.values()) {
    const events = [...player.events.values()].sort((a, b) => a.time - b.time);
    const created = events.find((event) => event.event === 'kMediaLogCreated');
    const started = events.find((event) => event.pipeline_state === 'kPlaying');
    const ended = events.find(
      (event) => event.event === 'kWebMediaPlayerDestroyed',
    );
    const name = player.properties.kVideoDecoderName;
    if (!name || !started || !created) continue;
    decoderNames[name] = (decoderNames[name] ?? 0) + 1;
    const createdAt = Date.parse(created.created);
    const loaded = events.find((event) => event.event === 'kLoad');
    const loadedAt = loaded
      ? createdAt + (loaded.time - created.time) * 1000
      : createdAt;
    const sourceEvent =
      loaded &&
      sourceEvents
        .filter(
          (event) =>
            event.source === loaded.url &&
            Math.abs(event.wallTime - loadedAt) < 1000,
        )
        .sort(
          (a, b) =>
            Math.abs(a.wallTime - loadedAt) - Math.abs(b.wallTime - loadedAt),
        )[0];
    const stage = sourceEvent?.role
      ? sourceEvent.role === 'thumbnail-or-metadata'
        ? 'thumbnail-or-metadata'
        : 'editor-playback-or-filmstrip'
      : canvasEnd && createdAt <= canvasEnd
        ? 'thumbnail-or-metadata'
        : 'editor-playback-or-filmstrip';
    decodeIntervals.push({ time: started.time, change: 1, stage });
    if (ended) decodeIntervals.push({ time: ended.time, change: -1, stage });
    categorized.push({
      id: player.id,
      stage,
      decoder: name,
      platformDecoder: player.properties.kIsPlatformVideoDecoder === 'true',
      createdAt,
      started: started.time,
      destroyed: ended?.time ?? null,
    });
  }
  decodeIntervals.sort((a, b) => a.time - b.time || a.change - b.change);
  const active = {
    total: 0,
    'thumbnail-or-metadata': 0,
    'editor-playback-or-filmstrip': 0,
  };
  const peak = { ...active };
  for (const interval of decodeIntervals) {
    active.total += interval.change;
    active[interval.stage] += interval.change;
    peak.total = Math.max(peak.total, active.total);
    peak[interval.stage] = Math.max(
      peak[interval.stage],
      active[interval.stage],
    );
  }
  return {
    decoderIdentifiedPipelinePeak: peak,
    decoderNames,
    pipelines: categorized,
    processPeakWorkingSetKiB: processPeakKiB,
    phaseWorkingSetKiB: phases.map((phase) => {
      const metric = metrics.findLast((sample) => sample.at <= phase.wallTime);
      return {
        name: phase.name,
        sampleAgeMs: metric ? phase.wallTime - metric.at : null,
        processes:
          metric?.value.map((process) => ({
            type: process.type,
            pid: process.pid,
            workingSetKiB: process.memory.workingSetSize,
          })) ?? [],
      };
    }),
    note: 'Pipeline concurrency spans Chromium kPlaying to WebMediaPlayerDestroyed with an identified video decoder. It is real media lifecycle evidence, not an OS hardware-decoder census. Working sets are Electron process measurements; summing them may count shared pages more than once.',
  };
}
