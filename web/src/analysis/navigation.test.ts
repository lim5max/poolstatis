import { describe, expect, it } from 'vitest';
import { PROJECT_MENU_ITEMS, activeNavigationItem, analyticsNavigationTarget, navigationForProject } from './navigation';

describe('mode-aware navigation contract', () => {
  it('keeps funnels directly reachable for every project mode', () => {
    expect(navigationForProject({ mode: 'website' }).primary.map((item) => item.label)).toEqual([
      'Home', 'Web', 'Funnels', 'Saved', 'People', 'Ship', 'Usage', 'Setup',
    ]);
    expect(navigationForProject({ mode: 'product' }).primary.map((item) => item.label)).toEqual([
      'Home', 'Product', 'Funnels', 'Saved', 'People', 'Ship', 'Usage', 'Setup',
    ]);
    expect(navigationForProject({ mode: 'both' }).primary.map((item) => item.label)).toEqual([
      'Home', 'Web', 'Product', 'Funnels', 'Saved', 'People', 'Ship', 'Usage', 'Setup',
    ]);
  });

  it('keeps a legacy project usable without fabricating a mode', () => {
    const legacy = navigationForProject({ mode: null });
    expect(legacy.primary).toHaveLength(9);
    expect(legacy.primary.map((item) => item.label)).toEqual(['Home', 'Web', 'Product', 'Funnels', 'Saved', 'People', 'Ship', 'Usage', 'Setup']);
    expect(legacy.secondary.map((item) => item.label)).toContain('Definitions');
    expect(legacy.secondary.map((item) => item.label)).toContain('Automations');
    expect(PROJECT_MENU_ITEMS).toContainEqual(expect.objectContaining({ label: 'Manage projects', to: '/projects' }));
  });

  it('resolves nested answer and control routes', () => {
    expect(activeNavigationItem('/analyze/product')).toBe('/analyze/product');
    expect(activeNavigationItem('/analyze/funnels')).toBe('/analyze/funnels');
    expect(activeNavigationItem('/analyze/saved')).toBe('/analyze/saved');
    expect(activeNavigationItem('/data/person/actor-1')).toBe('/data');
    expect(activeNavigationItem('/analyze/web')).toBe('/analyze/web');
    expect(activeNavigationItem('/analyze/users/actor-1')).toBe('/analyze/users');
    expect(activeNavigationItem('/measurement')).toBe('/measurement');
    expect(activeNavigationItem('/usage')).toBe('/usage');
    expect(activeNavigationItem('/automation')).toBe('/automation');
  });

  it('carries only valid date-range state to range-aware destinations', () => {
    expect(analyticsNavigationTarget('/analyze/product', '?range=today&metric=landing_visitors')).toBe(
      '/analyze/product?range=today',
    );
    expect(analyticsNavigationTarget('/experience', '?range=custom&from=2026-08-17&to=2026-08-18')).toBe(
      '/experience?range=custom&from=2026-08-17&to=2026-08-18',
    );
    expect(analyticsNavigationTarget('/analyze/saved', '?range=today')).toBe('/analyze/saved');
    expect(analyticsNavigationTarget('/analyze/web', '?range=custom&from=2026-02-30&to=2026-03-01')).toBe('/analyze/web');
    expect(analyticsNavigationTarget('/analyze/users', '?range=custom&from=2026-08-19&to=2026-08-18')).toBe('/analyze/users');
    expect(analyticsNavigationTarget('/analyze/product?metric=activation', '?range=today')).toBe(
      '/analyze/product?metric=activation&range=today',
    );
    expect(analyticsNavigationTarget('/analyze/funnels?funnel=activation#steps', '?range=custom&from=2026-08-01&to=2026-08-03')).toBe(
      '/analyze/funnels?funnel=activation&range=custom&from=2026-08-01&to=2026-08-03#steps',
    );
    expect(analyticsNavigationTarget('/data?tab=warnings&env=prod', '?range=90d')).toBe(
      '/data?tab=warnings&env=prod&range=90d',
    );
  });
});
