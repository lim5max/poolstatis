export type NavigationAvailability = 'available' | 'unavailable';

export interface NavigationItem {
  label: string;
  to?: string;
  availability: NavigationAvailability;
  reason?: string;
}

export interface NavigationZone {
  label: 'Overview' | 'Analyze' | 'Ship & decide' | 'Manage data';
  items: NavigationItem[];
}

export const NAVIGATION_ZONES: NavigationZone[] = [
  {
    label: 'Overview',
    items: [{ label: 'Overview', to: '/', availability: 'available' }],
  },
  {
    label: 'Analyze',
    items: [
      { label: 'Product analytics', to: '/analyze/product', availability: 'available' },
      { label: 'Web analytics', to: '/analyze/web', availability: 'available' },
      { label: 'Users', to: '/analyze/users', availability: 'available' },
    ],
  },
  {
    label: 'Ship & decide',
    items: [
      { label: 'Changes', to: '/changes', availability: 'available' },
      { label: 'Experiments', to: '/experiments', availability: 'available' },
      { label: 'Decisions', to: '/decisions', availability: 'available' },
    ],
  },
  {
    label: 'Manage data',
    items: [
      { label: 'Data', to: '/data', availability: 'available' },
      { label: 'Registry', to: '/registry', availability: 'available' },
      { label: 'Measurement', to: '/measurement', availability: 'available' },
      { label: 'Browser experience', to: '/experience', availability: 'available' },
      { label: 'Keys', to: '/keys', availability: 'available' },
      { label: 'Setup', to: '/setup', availability: 'available' },
    ],
  },
];

export const PROJECT_MENU_ITEMS = [
  { label: 'Manage projects', to: '/projects' },
] as const;

const AVAILABLE_ITEMS = NAVIGATION_ZONES
  .flatMap((zone) => zone.items)
  .filter((item): item is NavigationItem & { to: string } => item.availability === 'available' && Boolean(item.to));

export function activeNavigationItem(pathname: string): string | null {
  const match = AVAILABLE_ITEMS
    .filter((item) => item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0];
  return match?.to ?? null;
}
