export type ProjectMode = 'website' | 'product' | 'both';

export type NavigationAvailability = 'available' | 'unavailable';

export interface NavigationItem {
  label: string;
  to?: string;
  availability: NavigationAvailability;
  reason?: string;
}

export interface ProjectNavigationContext {
  mode: ProjectMode | null;
  goalIds?: string[];
}

export interface ProjectNavigation {
  primary: NavigationItem[];
  secondary: NavigationItem[];
}

const RANGE_AWARE_ROUTES = new Set([
  '/',
  '/analyze/web',
  '/analyze/product',
  '/analyze/funnels',
  '/analyze/users',
  '/data',
  '/experience',
]);
const RANGE_PRESETS = new Set(['today', 'yesterday', '7d', '30d', '90d']);

const HOME: NavigationItem = { label: 'Home', to: '/', availability: 'available' };
const WEB: NavigationItem = { label: 'Web', to: '/analyze/web', availability: 'available' };
const PRODUCT: NavigationItem = { label: 'Product', to: '/analyze/product', availability: 'available' };
const FUNNELS: NavigationItem = { label: 'Funnels', to: '/analyze/funnels', availability: 'available' };
const SAVED: NavigationItem = { label: 'Saved', to: '/analyze/saved', availability: 'available' };
const PEOPLE: NavigationItem = { label: 'People', to: '/analyze/users', availability: 'available' };
const SHIP: NavigationItem = { label: 'Ship', to: '/changes', availability: 'available' };
const USAGE: NavigationItem = { label: 'Usage', to: '/usage', availability: 'available' };
const SETUP: NavigationItem = { label: 'Setup', to: '/setup', availability: 'available' };

const SECONDARY_ITEMS: NavigationItem[] = [
  { label: 'Definitions', to: '/measurement', availability: 'available' },
  { label: 'Events', to: '/data', availability: 'available' },
  { label: 'Registry', to: '/registry', availability: 'available' },
  { label: 'Experience', to: '/experience', availability: 'available' },
  { label: 'Experiments', to: '/experiments', availability: 'available' },
  { label: 'Decisions', to: '/decisions', availability: 'available' },
  { label: 'Automations', to: '/automation', availability: 'available' },
  { label: 'Keys', to: '/keys', availability: 'available' },
];

/**
 * Missing intent is deliberately treated as legacy/unset. Legacy projects keep
 * broad access without being redirected into onboarding or assigned a mode.
 */
export function navigationForProject({ mode }: ProjectNavigationContext): ProjectNavigation {
  const primary = mode === 'website'
    ? [HOME, WEB, FUNNELS, SAVED, PEOPLE, SHIP, USAGE, SETUP]
    : mode === 'product'
      ? [HOME, PRODUCT, FUNNELS, SAVED, PEOPLE, SHIP, USAGE, SETUP]
      : [HOME, WEB, PRODUCT, FUNNELS, SAVED, PEOPLE, SHIP, USAGE, SETUP];

  return { primary, secondary: SECONDARY_ITEMS };
}

// Legacy export retained for callers that do not yet load project intent.
export const NAVIGATION_ZONES = [
  { label: 'Answers', items: navigationForProject({ mode: null }).primary },
  { label: 'Data & settings', items: SECONDARY_ITEMS },
] as const;

export const PROJECT_MENU_ITEMS = [
  { label: 'Manage projects', to: '/projects' },
] as const;

const ALL_ITEMS = [...navigationForProject({ mode: null }).primary, ...SECONDARY_ITEMS];

export function activeNavigationItem(pathname: string): string | null {
  const match = ALL_ITEMS
    .filter((item): item is NavigationItem & { to: string } => item.availability === 'available' && Boolean(item.to))
    .filter((item) => item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0];
  return match?.to ?? null;
}

export function analyticsNavigationTarget(to: string, currentSearch: string): string {
  const hashIndex = to.indexOf('#');
  const hash = hashIndex >= 0 ? to.slice(hashIndex) : '';
  const pathAndSearch = hashIndex >= 0 ? to.slice(0, hashIndex) : to;
  const queryIndex = pathAndSearch.indexOf('?');
  const pathname = queryIndex >= 0 ? pathAndSearch.slice(0, queryIndex) : pathAndSearch;
  const destinationSearch = queryIndex >= 0 ? pathAndSearch.slice(queryIndex + 1) : '';
  if (!isRangeAwareRoute(pathname)) return to;
  const current = new URLSearchParams(currentSearch);
  const range = current.get('range');
  const next = new URLSearchParams(destinationSearch);
  next.delete('range');
  next.delete('from');
  next.delete('to');
  if (range && RANGE_PRESETS.has(range)) {
    next.set('range', range);
  } else if (range === 'custom') {
    const from = current.get('from');
    const through = current.get('to');
    if (!isCalendarDate(from) || !isCalendarDate(through) || from > through) return to;
    next.set('range', 'custom');
    next.set('from', from);
    next.set('to', through);
  } else {
    return to;
  }
  const search = next.toString();
  return `${pathname}${search ? `?${search}` : ''}${hash}`;
}

function isRangeAwareRoute(to: string): boolean {
  return RANGE_AWARE_ROUTES.has(to)
    || to.startsWith('/analyze/users/')
    || to.startsWith('/data/person/');
}

function isCalendarDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
