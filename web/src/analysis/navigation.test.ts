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

  it('keeps only shipped Analyze routes navigable', () => {
    const analyze = NAVIGATION_ZONES.find((zone) => zone.label === 'Analyze');
    expect(analyze?.items.find((item) => item.label === 'Product analytics')).toMatchObject({
      to: '/analyze/product',
      availability: 'available',
    });
    expect(analyze?.items.find((item) => item.label === 'Web analytics')).toMatchObject({
      availability: 'unavailable',
    });
    expect(analyze?.items.find((item) => item.label === 'Users')).toMatchObject({
      availability: 'unavailable',
    });
    expect(analyze?.items.some((item) => item.label === 'Saved views')).toBe(false);
  });

  it('resolves active state for nested routes without activating unavailable items', () => {
    expect(activeNavigationItem('/analyze/product')).toBe('/analyze/product');
    expect(activeNavigationItem('/data/person/actor-1')).toBe('/data');
    expect(activeNavigationItem('/analyze/web')).toBeNull();
  });
});
