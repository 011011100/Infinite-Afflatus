/** Source-relative seconds; the source file is never modified. */
export interface ClipTrim {
  start: number;
  end: number;
}

export const MIN_CLIP_DURATION = 0.1;

export function clipRange(duration: number, trim?: ClipTrim): ClipTrim {
  const minimum = Math.min(MIN_CLIP_DURATION, duration);
  const start = Math.max(0, Math.min(trim?.start ?? 0, duration - minimum));
  return {
    start,
    end: Math.max(start + minimum, Math.min(trim?.end ?? duration, duration)),
  };
}

export function changeTrim(
  range: ClipTrim,
  edge: 'start' | 'end',
  value: number,
  duration: number,
): ClipTrim {
  const minimum = Math.min(MIN_CLIP_DURATION, duration);
  const time = Math.round(value * 1000) / 1000;
  return edge === 'start'
    ? { ...range, start: Math.max(0, Math.min(time, range.end - minimum)) }
    : {
        ...range,
        end: Math.min(duration, Math.max(time, range.start + minimum)),
      };
}
