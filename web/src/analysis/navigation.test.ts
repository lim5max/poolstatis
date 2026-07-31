import { describe, expect, it } from 'vitest';
import { NAVIGATION_ZONES, PROJECT_MENU_ITEMS, activeNavigationItem } from './navigation';

describe('task-oriented navigation contract', () => {
  it('exposes exactly the four approved zones without Projects as a primary item', () => {
    expect(NAVIGATION_ZONES.map((zone) => zone.label)).toEqual([
      'Overview',
      'Analyze',
      'Ship & decide',
      'Manage data',
    ]);
    expect(NAVIGATION_ZONES.flatMap((zone) => zone.items).some((item) => item.label === 'Projects')).toBe(false);
    expect(PROJECT_MENU_ITEMS).toContainEqual(expect.objectContaining({ label: 'Manage projects', to: '/projects' }));
  });

  it('keeps the shipped Analyze routes navigable', () => {
    const analyze = NAVIGATION_ZONES.find((zone) => zone.label === 'Analyze');
    expect(analyze?.items.find((item) => item.label === 'Product analytics')).toMatchObject({
      to: '/analyze/product',
      availability: 'available',
    });
    expect(analyze?.items.find((item) => item.label === 'Web analytics')).toMatchObject({
      to: '/analyze/web',
      availability: 'available',
    });
    expect(analyze?.items.find((item) => item.label === 'Users')).toMatchObject({
      to: '/analyze/users',
      availability: 'available',
    });
    expect(analyze?.items.some((item) => item.label === 'Saved views')).toBe(false);
  });

  it('resolves active state for nested Analyze and legacy data routes', () => {
    expect(activeNavigationItem('/analyze/product')).toBe('/analyze/product');
    expect(activeNavigationItem('/data/person/actor-1')).toBe('/data');
    expect(activeNavigationItem('/analyze/web')).toBe('/analyze/web');
    expect(activeNavigationItem('/analyze/users/actor-1')).toBe('/analyze/users');
  });
});
