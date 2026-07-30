import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  actorStatusLabel,
  engagementLabel,
  formatDurationMs,
  formatPercent,
  rangeDateFrom,
  webPageMetric,
} from './operations';
import type { Metric } from '../api/types';

const metric = (status: Metric['status']): Metric => ({
  id: 'metric-id',
  key: 'web_page_views',
  name: 'Web page views',
  purpose: 'Measure accepted canonical page views over time.',
  category: 'acquisition',
  tags: [],
  type: 'count',
  source: { event: 'page.viewed' },
  status,
  owner: null,
  deprecation_reason: null,
  deprecated_at: null,
});

describe('operational analytics UI semantics', () => {
  it('keeps unavailable evidence distinct from zero', () => {
    expect(formatPercent(null)).toBe('Unavailable');
    expect(formatDurationMs(null)).toBe('Unavailable');
    expect(engagementLabel(null)).toBe('Unknown');
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatDurationMs(0)).toBe('0 ms');
  });

  it('uses only the active reserved canonical page metric', () => {
    expect(webPageMetric([metric('proposed')])).toBeNull();
    expect(webPageMetric([metric('active')])?.key).toBe('web_page_views');
    expect(rangeDateFrom('30d')).toBe('-30d');
  });

  it('does not infer actor identity from properties or ID spelling', () => {
    expect(actorStatusLabel('unknown')).toBe('Unknown');
    expect(actorStatusLabel('linked')).toBe('Linked');
    const personSource = readFileSync(new URL('../screens/Person.tsx', import.meta.url), 'utf8');
    expect(personSource).not.toMatch(/deriveTraits|contactable|Delete events|purgeData|DangerConfirm/);
    expect(personSource).not.toMatch(/props\.(?:email|name)|['"]email['"]\s+in|['"]name['"]\s+in/);
  });

  it('keeps Users search exact-only and properties fail closed', () => {
    const usersSource = readFileSync(new URL('../screens/Users.tsx', import.meta.url), 'utf8');
    expect(usersSource).toContain("search: { kind: 'exact_id', value: search }");
    expect(usersSource).toContain('propertyFilters: []');
    expect(usersSource).not.toContain("kind: 'contains'");
  });
});
