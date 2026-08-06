import { describe, expect, it } from 'vitest';
import { PROJECT_MENU_ITEMS, activeNavigationItem, navigationForProject } from './navigation';

describe('mode-aware navigation contract', () => {
  it('keeps funnels directly reachable for every project mode', () => {
    expect(navigationForProject({ mode: 'website' }).primary.map((item) => item.label)).toEqual([
      'Home', 'Web', 'Funnels', 'People', 'Ship', 'Setup',
    ]);
    expect(navigationForProject({ mode: 'product' }).primary.map((item) => item.label)).toEqual([
      'Home', 'Product', 'Funnels', 'People', 'Ship', 'Setup',
    ]);
    expect(navigationForProject({ mode: 'both' }).primary.map((item) => item.label)).toEqual([
      'Home', 'Web', 'Product', 'Funnels', 'People', 'Ship', 'Setup',
    ]);
  });

  it('keeps a legacy project usable without fabricating a mode', () => {
    const legacy = navigationForProject({ mode: null });
    expect(legacy.primary).toHaveLength(7);
    expect(legacy.primary.map((item) => item.label)).toEqual(['Home', 'Web', 'Product', 'Funnels', 'People', 'Ship', 'Setup']);
    expect(legacy.secondary.map((item) => item.label)).toContain('Definitions');
    expect(PROJECT_MENU_ITEMS).toContainEqual(expect.objectContaining({ label: 'Manage projects', to: '/projects' }));
  });

  it('resolves nested answer and control routes', () => {
    expect(activeNavigationItem('/analyze/product')).toBe('/analyze/product');
    expect(activeNavigationItem('/analyze/funnels')).toBe('/analyze/funnels');
    expect(activeNavigationItem('/data/person/actor-1')).toBe('/data');
    expect(activeNavigationItem('/analyze/web')).toBe('/analyze/web');
    expect(activeNavigationItem('/analyze/users/actor-1')).toBe('/analyze/users');
    expect(activeNavigationItem('/measurement')).toBe('/measurement');
  });
});
