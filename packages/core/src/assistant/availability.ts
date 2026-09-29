export interface TimeWindow {
  start: number;
  end: number;
}

export function assistantFreeWindows(
  window: TimeWindow,
  busy: readonly TimeWindow[],
): TimeWindow[] {
  const result: TimeWindow[] = [];
  let cursor = window.start;
  for (const item of [...busy]
    .filter(
      (item) =>
        item.end > item.start &&
        item.end > window.start &&
        item.start < window.end,
    )
    .sort((a, b) => a.start - b.start)) {
    if (item.start > cursor)
      result.push({ start: cursor, end: Math.min(item.start, window.end) });
    cursor = Math.max(cursor, item.end);
  }
  if (cursor < window.end) result.push({ start: cursor, end: window.end });
  return result;
}
