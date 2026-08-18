export type AnalyticsRangePreset = 'today' | 'yesterday' | '7d' | '30d' | '90d';

export type AnalyticsRangeSelection =
  | { kind: 'preset'; preset: AnalyticsRangePreset }
  | { kind: 'custom'; from: string; to: string };

export interface ResolvedAnalyticsRange {
  from: string;
  to: string;
  label: string;
  days: number;
  complete: boolean;
}

const DAY_MS = 86_400_000;
const PRESET_DAYS: Record<Exclude<AnalyticsRangePreset, 'today' | 'yesterday'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};
const PRESETS = new Set<AnalyticsRangePreset>(['today', 'yesterday', '7d', '30d', '90d']);
export const DEFAULT_ANALYTICS_RANGE: AnalyticsRangeSelection = { kind: 'preset', preset: '30d' };

export function resolveAnalyticsRange(
  selection: AnalyticsRangeSelection,
  now = new Date(),
  timeZone = 'UTC',
): ResolvedAnalyticsRange {
  if (!Number.isFinite(now.getTime())) throw new Error('Analytics range anchor must be a valid date');
  if (timeZone !== 'UTC') throw new Error('Poolstatis analytics currently uses UTC calendar boundaries');

  if (selection.kind === 'custom') {
    const from = parseCalendarDate(selection.from);
    const through = parseCalendarDate(selection.to);
    if (!from || !through) throw new Error('Custom range dates must be valid calendar dates');
    if (from.getTime() > through.getTime()) throw new Error('Custom range start must not be after its end');
    const to = new Date(through.getTime() + DAY_MS);
    const days = Math.round((to.getTime() - from.getTime()) / DAY_MS);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      label: formatCustomRange(from, through),
      days,
      complete: to.getTime() <= now.getTime(),
    };
  }

  if (selection.preset === 'today') {
    const from = startOfUtcDay(now);
    return {
      from: from.toISOString(),
      to: now.toISOString(),
      label: 'Today',
      days: 1,
      complete: false,
    };
  }

  if (selection.preset === 'yesterday') {
    const to = startOfUtcDay(now);
    const from = new Date(to.getTime() - DAY_MS);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      label: 'Yesterday',
      days: 1,
      complete: true,
    };
  }

  const days = PRESET_DAYS[selection.preset];
  return {
    from: new Date(now.getTime() - days * DAY_MS).toISOString(),
    to: now.toISOString(),
    label: `Last ${days} days`,
    days,
    complete: false,
  };
}

export function previousAnalyticsRange(range: ResolvedAnalyticsRange): ResolvedAnalyticsRange {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new Error('Analytics range must be a valid non-empty interval');
  }
  const duration = to - from;
  return {
    from: new Date(from - duration).toISOString(),
    to: new Date(from).toISOString(),
    label: 'Previous period',
    days: Math.max(1, Math.ceil(duration / DAY_MS)),
    complete: true,
  };
}

export function rangeSearchParams(selection: AnalyticsRangeSelection): URLSearchParams {
  const search = new URLSearchParams();
  if (selection.kind === 'preset') {
    search.set('range', selection.preset);
  } else {
    search.set('range', 'custom');
    search.set('from', selection.from);
    search.set('to', selection.to);
  }
  return search;
}

export function rangeFromSearchParams(search: URLSearchParams): AnalyticsRangeSelection {
  const range = search.get('range');
  if (range === 'custom') {
    const from = search.get('from') ?? '';
    const to = search.get('to') ?? '';
    const parsedFrom = parseCalendarDate(from);
    const parsedTo = parseCalendarDate(to);
    if (parsedFrom && parsedTo && parsedFrom.getTime() <= parsedTo.getTime()) {
      return { kind: 'custom', from, to };
    }
    return DEFAULT_ANALYTICS_RANGE;
  }
  return range && PRESETS.has(range as AnalyticsRangePreset)
    ? { kind: 'preset', preset: range as AnalyticsRangePreset }
    : DEFAULT_ANALYTICS_RANGE;
}

export function selectionFromLegacyRange(range: '7d' | '30d' | '90d'): AnalyticsRangeSelection {
  return { kind: 'preset', preset: range };
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function parseCalendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = new Date(Date.UTC(year, month - 1, day));
  if (result.getUTCFullYear() !== year || result.getUTCMonth() !== month - 1 || result.getUTCDate() !== day) return null;
  return result;
}

function formatCustomRange(from: Date, through: Date): string {
  const sameYear = from.getUTCFullYear() === through.getUTCFullYear();
  const sameMonth = sameYear && from.getUTCMonth() === through.getUTCMonth();
  const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const full = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  if (from.getTime() === through.getTime()) return full.format(from);
  if (sameMonth) return `${monthDay.format(from).replace(/,$/, '')}–${through.getUTCDate()}, ${through.getUTCFullYear()}`;
  if (sameYear) return `${monthDay.format(from).replace(/,$/, '')}–${full.format(through)}`;
  return `${full.format(from)}–${full.format(through)}`;
}
