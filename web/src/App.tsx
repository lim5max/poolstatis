import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  ArrowLeft,
  ArrowRight,
  Browser,
  Catalogue,
  ChartAnalysis,
  ChevronsUpDown,
  DashboardSpeed,
  Database,
  Funnel,
  GitCommit,
  Globe,
  KeyRound,
  LayoutGrid,
  Menu,
  Plug,
  Ruler,
  TaskDone,
  TestTube,
  UserCircle,
  UserGroup,
  X,
  type PoolstatisIcon,
} from '@/components/icons';
import { hostedAuthEnabled, useHostedAuth } from './oidc';
import { useStore } from './store';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { DisclosureSummary } from '@/components/disclosure';
import { navigationForProject, type NavigationItem, type ProjectMode, type ProjectNavigation } from './analysis/navigation';
import { Connect } from './screens/Connect';
import { Projects } from './screens/Projects';
import { Overview } from './screens/Overview';
import { ProductAnalytics } from './screens/ProductAnalytics';
import { WebAnalytics } from './screens/WebAnalytics';
import { Users } from './screens/Users';
import { Registry } from './screens/Registry';
import { Data } from './screens/Data';
import { Keys } from './screens/Keys';
import { Setup } from './screens/Setup';
import { Person } from './screens/Person';
import { Onboarding } from './screens/Onboarding';
import { Experiments } from './screens/Experiments';
import { Experience } from './screens/Experience';
import { Measurement } from './screens/Measurement';
import { Changes } from './screens/Changes';
import { Decisions } from './screens/Decisions';
import { Profile } from './screens/Profile';
import { Usage } from './screens/Usage';
import { AuthPortal } from './screens/AuthPortal';

export const NAV_ICONS: Record<string, PoolstatisIcon> = {
  Attention: LayoutGrid,
  Home: LayoutGrid,
  Product: ChartAnalysis,
  Funnels: Funnel,
  Web: Globe,
  People: UserGroup,
  Ship: GitCommit,
  Events: Database,
  Definitions: Ruler,
  Experience: Browser,
  Overview: LayoutGrid,
  'Product analytics': ChartAnalysis,
  'Web analytics': Globe,
  Users: UserGroup,
  Changes: GitCommit,
  Experiments: TestTube,
  Decisions: TaskDone,
  Data: Database,
  Registry: Catalogue,
  Measurement: Ruler,
  'Browser experience': Browser,
  Keys: KeyRound,
  Setup: Plug,
  Usage: DashboardSpeed,
  Profile: UserCircle,
};
const TITLES: Record<string, string> = {
  '/': 'Attention',
  '/projects': 'Projects',
  '/analyze/product': 'Product',
  '/analyze/funnels': 'Funnels',
  '/usage': 'Usage',
  '/profile': 'Profile',
  '/analyze/web': 'Web',
  '/analyze/users': 'People',
  '/registry': 'Registry',
  '/measurement': 'Definitions',
  '/data': 'Events',
  '/keys': 'Keys',
  '/experiments': 'Experiments',
  '/experience': 'Experience',
  '/changes': 'Ship',
  '/decisions': 'Decisions',
  '/setup': 'Setup',
  '/onboarding': 'Onboarding',
};
const titleFor = (path: string) => (
  path.startsWith('/data/person') || path.startsWith('/analyze/users/')
    ? 'Actor profile'
    : TITLES[path] ?? 'Poolstatis'
);
const isProjectScoped = (path: string) => path === '/' || path.startsWith('/analyze') || path.startsWith('/setup') || path.startsWith('/registry') || path.startsWith('/measurement') || path.startsWith('/data') || path.startsWith('/keys') || path.startsWith('/experiments') || path.startsWith('/experience') || path.startsWith('/changes') || path.startsWith('/decisions');
const SIDEBAR_KEY = 'poolstatis.sidebar.collapsed';
const loadSidebarState = () => {
  try { return localStorage.getItem(SIDEBAR_KEY) === 'true'; } catch { return false; }
};
const saveSidebarState = (value: boolean) => {
  try { localStorage.setItem(SIDEBAR_KEY, String(value)); } catch { /* storage can be blocked */ }
};

export function App() {
  const authPortalHost = window.location.hostname === 'auth.poolstatis.xyz'
    || (import.meta.env.DEV && window.location.hostname === 'auth.localhost');
  if (authPortalHost) return <AuthPortal />;
  return <AdminApp />;
}

function AdminApp() {
  const { client, project } = useStore();
  const navigation = useProjectNavigation(client, project);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarState);
  const toggleSidebar = () => {
    setSidebarCollapsed((value) => {
      const next = !value;
      saveSidebarState(next);
      return next;
    });
  };
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setMobileNavOpen(false);
    };
    closeOnDesktop();
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);
  if (!client) return <Connect />;
  return (
    <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
      <a href="#main-content" className="fixed left-3 top-3 z-50 -translate-y-20 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground shadow-lg transition-transform focus:translate-y-0">
        Skip to content
      </a>
      <div className="min-h-screen bg-background md:flex md:h-screen">
        <MobileTopbar />
        <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} navigation={navigation} />
        <MobileNavDrawer navigation={navigation} onNavigate={() => setMobileNavOpen(false)} />
        <Main />
      </div>
    </Dialog>
  );
}

function Sidebar({ collapsed, onToggle, navigation }: { collapsed: boolean; onToggle: () => void; navigation: ProjectNavigation }) {
  return (
    <aside
      className={cn(
        'hidden min-h-0 shrink-0 flex-col border-r bg-sidebar py-4 transition-[width] duration-200 md:flex',
        collapsed ? 'w-18' : 'w-60',
      )}
      aria-label="Primary navigation"
    >
      <div className={cn('flex items-center pb-3', collapsed ? 'flex-col gap-2 px-2' : 'justify-between gap-2 px-4')}>
        <div className={cn('min-w-0', collapsed && 'flex justify-center')}>
          <div className={cn('brand-wordmark flex items-center gap-2.5 text-2xl', collapsed && 'justify-center')}>
            <img className="size-8 shrink-0" src="/poolstatis-logo.svg" alt="" />
            {!collapsed && <span>Poolstatis</span>}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!collapsed}
          className="shrink-0"
        >
          {collapsed ? <ArrowRight className="size-4" /> : <ArrowLeft className="size-4" />}
        </Button>
      </div>
      <nav className={cn('min-h-0 flex-1 overflow-y-auto', collapsed ? 'px-2' : 'px-3')} aria-label="Customer admin">
        <NavGroups collapsed={collapsed} navigation={navigation} />
      </nav>
      <ConnectionFooter collapsed={collapsed} />
    </aside>
  );
}

function MobileTopbar() {
  return (
    <header className="sticky top-0 z-30 flex min-h-14 items-center justify-between border-b bg-background/95 px-4 backdrop-blur-md md:hidden">
      <div className="flex min-w-0 items-center gap-2.5">
        <img className="size-7 shrink-0" src="/poolstatis-logo.svg" alt="" />
        <span className="brand-wordmark truncate text-xl text-foreground">Poolstatis</span>
      </div>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="size-11" aria-label="Open navigation">
          <Menu className="size-5" />
        </Button>
      </DialogTrigger>
    </header>
  );
}

function MobileNavDrawer({ onNavigate, navigation }: { onNavigate: () => void; navigation: ProjectNavigation }) {
  return (
    <DialogContent
      showCloseButton={false}
      overlayClassName="bg-background/80 backdrop-blur-sm md:hidden"
      className="top-0 left-0 flex h-dvh max-h-dvh w-80 max-w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto rounded-none border-y-0 border-l-0 border-r bg-sidebar p-0 shadow-xl sm:max-w-none md:hidden data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
    >
      <DialogTitle className="sr-only">Navigation</DialogTitle>
      <DialogDescription className="sr-only">Navigate between Poolstatis admin sections.</DialogDescription>
      <aside className="flex min-h-full flex-col py-4">
        <div className="flex items-center justify-between gap-3 px-5 pb-4">
          <div className="min-w-0">
            <div className="brand-wordmark flex items-center gap-2.5 text-2xl">
              <img className="size-8 shrink-0" src="/poolstatis-logo.svg" alt="" /> Poolstatis
            </div>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="size-11" aria-label="Close navigation">
              <X className="size-4" />
            </Button>
          </DialogClose>
        </div>
        <nav className="flex-1 px-3" aria-label="Customer admin">
          <NavGroups navigation={navigation} onNavigate={onNavigate} />
        </nav>
        <ConnectionFooter onDisconnect={onNavigate} />
      </aside>
    </DialogContent>
  );
}

function NavGroups({ navigation, onNavigate, collapsed = false }: { navigation: ProjectNavigation; onNavigate?: () => void; collapsed?: boolean }) {
  return (
    <>
      <div className="mb-1">
        {navigation.primary.map((item) => (
          <NavigationRow key={item.label} item={item} collapsed={collapsed} onNavigate={onNavigate} />
        ))}
      </div>
      <SecondaryNavigation navigation={navigation} collapsed={collapsed} onNavigate={onNavigate} />
    </>
  );
}

function SecondaryNavigation({ navigation, collapsed, onNavigate }: {
  navigation: ProjectNavigation;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  if (collapsed) {
    return (
      <div className="mt-2 border-t pt-2">
        <NavigationRow item={{ label: 'Definitions', to: '/measurement', availability: 'available' }} collapsed onNavigate={onNavigate} />
      </div>
    );
  }
  return (
    <details className="group/disclosure mt-2 border-t pt-2">
      <DisclosureSummary className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-control px-3 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/10 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring md:min-h-9">
        <Catalogue className="size-4 shrink-0" />
        Data &amp; settings
      </DisclosureSummary>
      <div className="mt-1 border-l pl-2">
        {navigation.secondary.map((item) => <NavigationRow key={item.label} item={item} collapsed={false} onNavigate={onNavigate} />)}
      </div>
    </details>
  );
}

function NavigationRow({ item, collapsed, onNavigate }: {
  item: NavigationItem;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = NAV_ICONS[item.label] ?? LayoutGrid;
  if (item.availability === 'unavailable' || !item.to) {
    return (
      <div
        aria-disabled="true"
        title={item.reason}
        className={cn(
          'flex min-h-11 cursor-not-allowed items-center rounded-control text-sm text-muted-foreground/60 md:min-h-9',
          collapsed ? 'justify-center px-2' : 'gap-2.5 px-3',
        )}
      >
        <Icon className="size-4 shrink-0" />
        <span className={collapsed ? 'sr-only' : undefined}>{item.label}</span>
        {!collapsed && <span className="ml-auto text-xs">Later</span>}
      </div>
    );
  }
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={({ isActive }) => cn(
        'flex min-h-11 items-center rounded-control text-sm transition-colors md:min-h-9',
        collapsed ? 'justify-center px-2' : 'gap-2.5 px-3',
        isActive
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent/10 hover:text-sidebar-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className={collapsed ? 'sr-only' : undefined}>{item.label}</span>
    </NavLink>
  );
}

function ConnectionFooter({ onDisconnect, collapsed = false }: { onDisconnect?: () => void; collapsed?: boolean }) {
  const { client, disconnect, tokenKind } = useStore();
  if (hostedAuthEnabled && tokenKind === 'user') return <HostedConnectionFooter onDisconnect={onDisconnect} collapsed={collapsed} />;
  const handleDisconnect = () => {
    disconnect();
    onDisconnect?.();
  };
  return (
    <div aria-label="Account navigation" className={cn('mt-2 border-t pt-3', collapsed ? 'flex justify-center gap-1 px-2' : 'flex items-center justify-between gap-2 px-5')}>
      {!collapsed && <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn('size-1.5 rounded-full', client ? 'bg-muted-foreground' : 'bg-destructive')} /> {tokenKind ?? 'admin'} key session
      </span>}
      <div className="flex items-center gap-1">
        <AccountProfileLink collapsed={collapsed} onNavigate={onDisconnect} />
        <Button variant="ghost" size={collapsed ? 'icon-sm' : 'sm'} className={cn('text-xs text-muted-foreground', !collapsed && 'h-7')} onClick={handleDisconnect} aria-label={collapsed ? 'Disconnect admin session' : undefined}>
          {collapsed ? <X className="size-4" /> : 'disconnect'}
        </Button>
      </div>
    </div>
  );
}

function HostedConnectionFooter({ onDisconnect, collapsed = false }: { onDisconnect?: () => void; collapsed?: boolean }) {
  const { client, disconnect } = useStore();
  const { logout } = useHostedAuth();
  const handleDisconnect = () => {
    disconnect();
    onDisconnect?.();
    void logout();
  };
  return (
    <div aria-label="Account navigation" className={cn('mt-2 border-t pt-3', collapsed ? 'flex justify-center gap-1 px-2' : 'flex items-center justify-between gap-2 px-5')}>
      {!collapsed && <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn('size-1.5 rounded-full', client ? 'bg-muted-foreground' : 'bg-destructive')} /> hosted session
      </span>}
      <div className="flex items-center gap-1">
        <AccountProfileLink collapsed={collapsed} onNavigate={onDisconnect} />
        <Button variant="ghost" size={collapsed ? 'icon-sm' : 'sm'} className={cn('text-xs text-muted-foreground', !collapsed && 'h-7')} onClick={handleDisconnect} aria-label={collapsed ? 'Sign out' : undefined}>
          {collapsed ? <X className="size-4" /> : 'sign out'}
        </Button>
      </div>
    </div>
  );
}

function AccountProfileLink({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  return (
    <NavLink
      to="/profile"
      onClick={onNavigate}
      aria-label={collapsed ? 'Profile' : undefined}
      className={({ isActive }) => cn(
        'flex items-center rounded-control text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent/10 hover:text-sidebar-foreground',
        collapsed ? 'size-8 justify-center' : 'h-7 gap-1.5 px-2',
        isActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
      )}
    >
      <UserCircle className="size-4" />
      {!collapsed && <span>Profile</span>}
    </NavLink>
  );
}

function Main() {
  const loc = useLocation();
  const navigate = useNavigate();
  const { projects, project, setProject, env } = useStore();
  const title = titleFor(loc.pathname);
  const showProject = isProjectScoped(loc.pathname);

  return (
    <div className="min-h-0 min-w-0 flex-1 md:h-screen md:overflow-y-auto">
      <div className="sticky top-14 z-10 flex min-h-14 items-center border-b bg-background/90 px-4 py-3 backdrop-blur-md md:top-0 md:px-8">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Poolstatis</span>
            {showProject && project && (
              <>
                <span className="text-muted-foreground/50">/</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-11 max-w-full gap-1.5 md:h-7">
                      <span className="max-w-40 truncate md:max-w-none">{project}</span>
                      <ChevronsUpDown className="size-3 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {projects.map((p) => (
                      <DropdownMenuItem key={p.slug} onClick={() => setProject(p.slug)}>{p.slug}</DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => navigate('/projects')}>Manage projects</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
            <span className="text-muted-foreground/50">/</span>
            <span className="font-medium text-foreground">{title}</span>
            {showProject && project && <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{env}</code>}
          </div>
        </div>
      </div>
      <motion.main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-7xl p-4 pb-20 outline-none md:p-8" key={loc.pathname}
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, ease: 'easeOut' }}>
        <SetupResumeBanner path={loc.pathname} />
        <Routes>
          <Route path="/" element={<Guarded><Overview /></Guarded>} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/analyze/product" element={<Guarded><ProductAnalytics /></Guarded>} />
          <Route path="/analyze/funnels" element={<Guarded><ProductAnalytics surface="funnels" /></Guarded>} />
          <Route path="/analyze/web" element={<Guarded><WebAnalytics /></Guarded>} />
          <Route path="/analyze/users" element={<Guarded><Users /></Guarded>} />
          <Route path="/analyze/users/:distinctId" element={<Guarded><Person /></Guarded>} />
          <Route path="/registry" element={<Guarded><Registry /></Guarded>} />
          <Route path="/measurement" element={<Guarded><Measurement /></Guarded>} />
          <Route path="/data" element={<Guarded><Data /></Guarded>} />
          <Route path="/data/person/:distinctId" element={<Guarded><Person /></Guarded>} />
          <Route path="/keys" element={<Guarded><Keys /></Guarded>} />
          <Route path="/experiments" element={<Guarded><Experiments /></Guarded>} />
          <Route path="/experience" element={<Guarded><Experience /></Guarded>} />
          <Route path="/changes" element={<Guarded><Changes /></Guarded>} />
          <Route path="/decisions" element={<Guarded><Decisions /></Guarded>} />
          <Route path="/setup" element={<Setup />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </motion.main>
    </div>
  );
}

function SetupResumeBanner({ path }: { path: string }) {
  const { client, project, env } = useStore();
  const [nextAction, setNextAction] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setNextAction(null);
    if (!client || !project || !isProjectScoped(path) || path === '/setup') return () => { active = false; };
    void client.onboardingStatus(project, env)
      .then((status) => {
        if (!active) return;
        const sourceReady = status.gates.find((gate) => gate.key === 'data_source_connected')?.complete ?? false;
        const eventSeen = status.gates.find((gate) => gate.key === 'first_event_observed')?.complete ?? false;
        if (!sourceReady) setNextAction('Create and save a product key');
        else if (!eventSeen) setNextAction('Copy the setup task and send your first event');
      })
      .catch(() => {
        if (active) setNextAction(null);
      });
    return () => { active = false; };
  }, [client, env, path, project]);

  if (!nextAction) return null;
  return (
    <section
      aria-label="Finish project setup"
      className="mb-5 flex flex-col gap-3 rounded-panel border border-primary/45 bg-primary/10 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <div className="text-sm font-semibold">Finish project setup</div>
        <p className="mt-1 text-sm text-muted-foreground">Next: {nextAction}.</p>
      </div>
      <Button asChild variant="outline" className="shrink-0 bg-card">
        <Link to="/setup">Open Setup <ArrowRight className="size-4" /></Link>
      </Button>
    </section>
  );
}

interface IntentNavigationResponse {
  intent: {
    project_mode: ProjectMode;
    goal_ids: string[];
    primary_goal_id: string;
  } | null;
}

interface IntentCapableClient {
  projectIntent?: (slug: string) => Promise<IntentNavigationResponse>;
}

function useProjectNavigation(client: ReturnType<typeof useStore>['client'], project: string | null): ProjectNavigation {
  const [context, setContext] = useState<{ project: string | null; mode: ProjectMode | null; goalIds: string[] }>({
    project: null,
    mode: null,
    goalIds: [],
  });

  useEffect(() => {
    let current = true;
    setContext({ project, mode: null, goalIds: [] });
    if (!client || !project) return () => { current = false; };
    const intentClient = client as unknown as IntentCapableClient;
    if (!intentClient.projectIntent) return () => { current = false; };
    void intentClient.projectIntent(project)
      .then(({ intent }) => {
        if (current) setContext({ project, mode: intent?.project_mode ?? null, goalIds: intent?.goal_ids ?? [] });
      })
      .catch(() => {
        // Legacy/unset and temporarily unavailable intent both keep broad access.
        if (current) setContext({ project, mode: null, goalIds: [] });
      });
    return () => { current = false; };
  }, [client, project]);

  return navigationForProject({
    mode: context.project === project ? context.mode : null,
    goalIds: context.project === project ? context.goalIds : [],
  });
}

function Guarded({ children }: { children: ReactNode }) {
  const {
    account,
    project,
    projects,
    tokenKind,
    envReady,
    envError,
    retryEnvValidation,
  } = useStore();
  const canCreateFirstProject = tokenKind === 'user'
    && projects.length === 0
    && (account?.membership.role === 'owner' || account?.membership.role === 'admin');
  if (!project && canCreateFirstProject) return <Navigate to="/onboarding" replace />;
  if (!project) return <div className="flex flex-col items-center gap-2 py-14 text-center text-muted-foreground"><div className="serif text-xl text-foreground/70">No project selected</div><div>Choose one from the project switcher.</div></div>;
  if (envError) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-14 text-center">
        <div className="serif text-xl text-foreground">Environment unavailable</div>
        <div className="max-w-sm text-sm text-muted-foreground">{envError} Retry before running queries.</div>
        <Button variant="outline" className="h-11 md:h-9" onClick={retryEnvValidation}>Retry validation</Button>
      </div>
    );
  }
  if (!envReady) return <div className="py-14 text-center text-sm text-muted-foreground">Validating project environment…</div>;
  return <>{children}</>;
}
