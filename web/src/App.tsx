import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { motion } from 'motion/react';
import { LayoutGrid, List, Database, GridView, KeyRound, Settings, SystemSettings, Target, PackageBox, Check, ChevronsUpDown, Menu, X, ArrowLeft, ArrowRight, type PoolstatisIcon } from '@/components/icons';
import { hostedAuthEnabled, useHostedAuth } from './oidc';
import { useStore } from './store';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Connect } from './screens/Connect';
import { Projects } from './screens/Projects';
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

type NavItem = { to: string; Icon: PoolstatisIcon; label: string; end?: boolean };
const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  { label: 'Get started', items: [
    { to: '/', Icon: LayoutGrid, label: 'Projects', end: true },
    { to: '/setup', Icon: Settings, label: 'Setup & MCP' },
  ] },
  { label: 'Measure', items: [
    { to: '/registry', Icon: List, label: 'Registry' },
    { to: '/data', Icon: Database, label: 'Data' },
    { to: '/measurement', Icon: SystemSettings, label: 'Measurement' },
  ] },
  { label: 'Ship & learn', items: [
    { to: '/experiments', Icon: Target, label: 'Experiments' },
    { to: '/experience', Icon: GridView, label: 'Experience' },
    { to: '/changes', Icon: PackageBox, label: 'Changes' },
    { to: '/decisions', Icon: Check, label: 'Decisions' },
  ] },
  { label: 'Workspace', items: [
    { to: '/keys', Icon: KeyRound, label: 'Keys' },
    { to: '/usage', Icon: Database, label: 'Usage' },
    { to: '/profile', Icon: Settings, label: 'Profile' },
  ] },
];
const TITLES: Record<string, string> = { '/': 'Projects', '/usage': 'Usage', '/profile': 'Profile', '/registry': 'Registry', '/measurement': 'Measurement', '/data': 'Data', '/keys': 'Keys', '/experiments': 'Experiments', '/experience': 'Experience', '/changes': 'Changes', '/decisions': 'Decisions', '/setup': 'Setup & MCP' };
const PAGE_LEADS: Record<string, string> = {
  '/': 'Choose the project this admin session manages.',
  '/setup': 'Connect an agent, send data, and verify the first query.',
  '/registry': 'Declare what measurements mean before agents query them.',
  '/data': 'Inspect accepted events, entities, health, and warnings.',
  '/measurement': 'Verify identity, properties, and source evidence.',
  '/experiments': 'Control flags and evidence-backed experiments.',
  '/experience': 'Inspect captured interaction evidence.',
  '/changes': 'Register releases and evaluate measured impact.',
  '/decisions': 'Review evidence, record outcomes, and approve exact actions.',
  '/keys': 'Issue, audit, and revoke scoped access.',
  '/usage': 'Review stored-event usage and monthly limits.',
  '/profile': 'Manage identity and personal MCP tokens.',
};
const titleFor = (path: string) => (path.startsWith('/data/person') ? 'Person' : TITLES[path] ?? 'Poolstatis');
const leadFor = (path: string) => path.startsWith('/data/person')
  ? 'Inspect one actor without exposing raw credentials.'
  : PAGE_LEADS[path] ?? '';
const isProjectScoped = (path: string) => path === '/' || path.startsWith('/setup') || path.startsWith('/registry') || path.startsWith('/measurement') || path.startsWith('/data') || path.startsWith('/keys') || path.startsWith('/experiments') || path.startsWith('/experience') || path.startsWith('/changes') || path.startsWith('/decisions');
const SIDEBAR_KEY = 'poolstatis.sidebar.collapsed';
const loadSidebarState = () => {
  try { return localStorage.getItem(SIDEBAR_KEY) === 'true'; } catch { return false; }
};
const saveSidebarState = (value: boolean) => {
  try { localStorage.setItem(SIDEBAR_KEY, String(value)); } catch { /* storage can be blocked */ }
};

export function App() {
  if (window.location.hostname === 'auth.poolstatis.xyz') return <AuthPortal />;
  return <AdminApp />;
}

function AdminApp() {
  const { client } = useStore();
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
      <div className={cn(
        'min-h-screen bg-background md:grid md:h-screen md:transition-[grid-template-columns] md:duration-200',
        sidebarCollapsed ? 'md:grid-cols-[72px_1fr]' : 'md:grid-cols-[232px_1fr]',
      )}>
        <MobileTopbar />
        <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
        <MobileNavDrawer onNavigate={() => setMobileNavOpen(false)} />
        <Main />
      </div>
    </Dialog>
  );
}

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <aside className="hidden min-h-0 flex-col border-r bg-sidebar py-4 md:flex" aria-label="Primary navigation">
      <div className={cn('flex items-start pb-3', collapsed ? 'flex-col items-center gap-2 px-2' : 'justify-between gap-2 px-4')}>
        <div className={cn('min-w-0', collapsed && 'flex justify-center')}>
          <div className={cn('brand-wordmark flex items-center gap-2.5 text-2xl', collapsed && 'justify-center')}>
            <img className="size-8 shrink-0" src="/poolstatis-logo.svg" alt="" />
            {!collapsed && <span>Poolstatis</span>}
          </div>
          {!collapsed && <div className="mt-1 text-xs text-muted-foreground">Customer admin</div>}
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
        <NavGroups collapsed={collapsed} />
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
        <Button variant="ghost" size="icon-sm" aria-label="Open navigation">
          <Menu className="size-5" />
        </Button>
      </DialogTrigger>
    </header>
  );
}

function MobileNavDrawer({ onNavigate }: { onNavigate: () => void }) {
  return (
    <DialogContent
      showCloseButton={false}
      overlayClassName="bg-background/80 backdrop-blur-sm md:hidden"
      className="top-0 left-0 flex h-dvh max-h-dvh w-80 max-w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto rounded-none border-y-0 border-l-0 border-r bg-sidebar p-0 shadow-xl sm:max-w-none md:hidden data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
    >
      <DialogTitle className="sr-only">Navigation</DialogTitle>
      <DialogDescription className="sr-only">Navigate between Poolstatis admin sections.</DialogDescription>
      <aside className="flex min-h-full flex-col py-4">
        <div className="flex items-start justify-between gap-3 px-5 pb-4">
          <div className="min-w-0">
            <div className="brand-wordmark flex items-center gap-2.5 text-2xl">
              <img className="size-8 shrink-0" src="/poolstatis-logo.svg" alt="" /> Poolstatis
            </div>
            <div className="mt-1 text-xs text-muted-foreground">Customer admin</div>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close navigation">
              <X className="size-4" />
            </Button>
          </DialogClose>
        </div>
        <nav className="flex-1 px-3" aria-label="Customer admin">
          <NavGroups onNavigate={onNavigate} />
        </nav>
        <ConnectionFooter onDisconnect={onNavigate} />
      </aside>
    </DialogContent>
  );
}

function NavGroups({ onNavigate, collapsed = false }: { onNavigate?: () => void; collapsed?: boolean }) {
  return (
    <>
      {NAV_GROUPS.map((g) => (
        <div key={g.label} className="mb-1">
          {collapsed
            ? <div className="mx-2 my-2 border-t" aria-hidden="true" />
            : <div className="px-3 pb-1.5 pt-3.5 text-xs font-medium text-muted-foreground/70">{g.label}</div>}
          {g.items.map(({ to, Icon, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onNavigate}
              title={collapsed ? label : undefined}
              aria-label={collapsed ? label : undefined}
              className={({ isActive }) => cn('flex min-h-9 items-center rounded-md text-sm transition-colors',
                collapsed ? 'justify-center px-2' : 'gap-2.5 px-3 py-2',
                isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}
            >
              <Icon className="size-4 shrink-0" />
              <span className={collapsed ? 'sr-only' : undefined}>{label}</span>
            </NavLink>
          ))}
        </div>
      ))}
    </>
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
    <div className={cn('mt-2 border-t pt-3', collapsed ? 'flex justify-center px-2' : 'flex items-center justify-between px-5')}>
      {!collapsed && <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn('size-1.5 rounded-full', client ? 'bg-muted-foreground' : 'bg-destructive')} /> {tokenKind ?? 'admin'} key session
      </span>}
      <Button variant="ghost" size={collapsed ? 'icon-sm' : 'sm'} className={cn('text-xs text-muted-foreground', !collapsed && 'h-7')} onClick={handleDisconnect} aria-label={collapsed ? 'Disconnect admin session' : undefined}>
        {collapsed ? <X className="size-4" /> : 'disconnect'}
      </Button>
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
    <div className={cn('mt-2 border-t pt-3', collapsed ? 'flex justify-center px-2' : 'flex items-center justify-between px-5')}>
      {!collapsed && <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn('size-1.5 rounded-full', client ? 'bg-muted-foreground' : 'bg-destructive')} /> hosted session
      </span>}
      <Button variant="ghost" size={collapsed ? 'icon-sm' : 'sm'} className={cn('text-xs text-muted-foreground', !collapsed && 'h-7')} onClick={handleDisconnect} aria-label={collapsed ? 'Sign out' : undefined}>
        {collapsed ? <X className="size-4" /> : 'sign out'}
      </Button>
    </div>
  );
}

function Main() {
  const loc = useLocation();
  const { projects, project, setProject, env } = useStore();
  const title = titleFor(loc.pathname);
  const lead = leadFor(loc.pathname);
  const showProject = isProjectScoped(loc.pathname);

  return (
    <div className="min-h-0 md:h-screen md:overflow-y-auto">
      <div className="sticky top-14 z-10 flex min-h-16 items-center border-b bg-background/90 px-4 py-3 backdrop-blur-md md:top-0 md:px-8">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Poolstatis</span>
            {showProject && project && (
              <>
                <span className="text-muted-foreground/50">/</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-7 max-w-full gap-1.5">
                      <span className="max-w-40 truncate md:max-w-none">{project}</span>
                      <ChevronsUpDown className="size-3 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {projects.map((p) => (
                      <DropdownMenuItem key={p.slug} onClick={() => setProject(p.slug)}>{p.slug}</DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
            <span className="text-muted-foreground/50">/</span>
            <span className="font-medium text-foreground">{title}</span>
            {showProject && project && <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{env}</code>}
          </div>
          {lead && <p className="text-xs text-muted-foreground">{lead}</p>}
        </div>
      </div>
      <motion.main id="main-content" tabIndex={-1} className="max-w-6xl p-4 pb-20 outline-none md:p-8" key={loc.pathname}
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, ease: 'easeOut' }}>
        <Routes>
          <Route path="/" element={<Projects />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/usage" element={<Usage />} />
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

function Guarded({ children }: { children: ReactNode }) {
  const { project } = useStore();
  if (!project) return <div className="flex flex-col items-center gap-2 py-14 text-center text-muted-foreground"><div className="serif text-xl text-foreground/70">No project selected</div><div>Choose a project in Projects.</div></div>;
  return <>{children}</>;
}
