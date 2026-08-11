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

const ATTENTION: NavigationItem = { label: 'Attention', to: '/', availability: 'available' };
const WEB: NavigationItem = { label: 'Web', to: '/analyze/web', availability: 'available' };
const PRODUCT: NavigationItem = { label: 'Product', to: '/analyze/product', availability: 'available' };
const FUNNELS: NavigationItem = { label: 'Funnels', to: '/analyze/funnels', availability: 'available' };
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
  { label: 'Keys', to: '/keys', availability: 'available' },
];

/**
 * Missing intent is deliberately treated as legacy/unset. Legacy projects keep
 * broad access without being redirected into onboarding or assigned a mode.
 */
export function navigationForProject({ mode }: ProjectNavigationContext): ProjectNavigation {
  const primary = mode === 'website'
    ? [ATTENTION, WEB, FUNNELS, PEOPLE, SHIP, USAGE, SETUP]
    : mode === 'product'
      ? [ATTENTION, PRODUCT, FUNNELS, PEOPLE, SHIP, USAGE, SETUP]
      : [ATTENTION, WEB, PRODUCT, FUNNELS, PEOPLE, SHIP, USAGE, SETUP];

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
