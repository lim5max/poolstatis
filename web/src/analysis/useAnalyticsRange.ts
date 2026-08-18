import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  DEFAULT_ANALYTICS_RANGE,
  rangeFromSearchParams,
  rangeSearchParams,
  resolveAnalyticsRange,
  type AnalyticsRangeSelection,
} from './ranges';

const RANGE_KEYS = ['range', 'from', 'to'] as const;

export function useAnalyticsRange(defaultSelection: AnalyticsRangeSelection = DEFAULT_ANALYTICS_RANGE) {
  const [search, setSearch] = useSearchParams();
  const hasRange = search.has('range');
  const selection = useMemo(
    () => hasRange ? rangeFromSearchParams(search) : defaultSelection,
    [defaultSelection, hasRange, search],
  );
  const resolved = useMemo(() => resolveAnalyticsRange(selection), [selection]);
  const setSelection = useCallback((next: AnalyticsRangeSelection) => {
    const updated = new URLSearchParams(search);
    for (const key of RANGE_KEYS) updated.delete(key);
    rangeSearchParams(next).forEach((value, key) => updated.set(key, value));
    setSearch(updated, { replace: true });
  }, [search, setSearch]);

  return { selection, resolved, setSelection };
}
