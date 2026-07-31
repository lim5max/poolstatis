const CHART_SERIES_COUNT = 5;

export function chartSeriesStroke(index: number): string | undefined {
  return index % CHART_SERIES_COUNT === 0 ? 'var(--chart-1-stroke)' : undefined;
}
