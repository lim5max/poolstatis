import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';
import { motion, useReducedMotion } from 'motion/react';
import { LayoutGrid, List, Database, GridView, KeyRound, Settings, SystemSettings, Target, PackageBox, Check, ChevronsUpDown, Menu, X, type PoolstatisIcon } from '@/components/icons';
import { auth0Enabled } from './auth0';
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

type NavItem = { to: string; Icon: PoolstatisIcon; label: string; end?: boolean };
const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  { label: 'Workspace', items: [{ to: '/', Icon: LayoutGrid, label: 'Projects', end: true }] },
  { label: 'Instrument', items: [
    { to: '/registry', Icon: List, label: 'Registry' },
    { to: '/measurement', Icon: SystemSettings, label: 'Measurement' },
    { to: '/data', Icon: Database, label: 'Data' },
    { to: '/keys', Icon: KeyRound, label: 'Keys' },
    { to: '/experiments', Icon: Target, label: 'Experiments' },
    { to: '/experience', Icon: GridView, label: 'Experience' },
  ] },
  { label: 'Decide', items: [
    { to: '/changes', Icon: PackageBox, label: 'Changes' },
    { to: '/decisions', Icon: Check, label: 'Decisions' },
  ] },
  { label: 'System', items: [{ to: '/setup', Icon: Settings, label: 'Setup & MCP' }] },
];
const TITLES: Record<string, string> = { '/': 'Projects', '/registry': 'Registry', '/measurement': 'Measurement', '/data': 'Data', '/keys': 'Keys', '/experiments': 'Experiments', '/experience': 'Experience', '/changes': 'Changes', '/decisions': 'Decisions', '/setup': 'Setup & MCP' };
const titleFor = (path: string) => (path.startsWith('/data/person') ? 'Person' : TITLES[path] ?? 'Poolstatis');
const isProjectScoped = (path: string) => path === '/' || path.startsWith('/registry') || path.startsWith('/measurement') || path.startsWith('/data') || path.startsWith('/keys') || path.startsWith('/experiments') || path.startsWith('/experience') || path.startsWith('/changes') || path.startsWith('/decisions');

export function App() {
  const { client } = useStore();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
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
      <div className="min-h-dvh bg-background md:grid md:h-dvh md:grid-cols-[232px_1fr]">
        <MobileTopbar />
        <Sidebar />
        <MobileNavDrawer onNavigate={() => setMobileNavOpen(false)} />
        <Main />
      </div>
    </Dialog>
  );
}

function Sidebar() {
  return (
    <aside className="hidden flex-col border-r bg-sidebar py-5 md:flex">
      <div className="px-5 pb-4 md:pb-5">
        <div className="brand-wordmark flex items-center gap-2.5 text-2xl">
          <img className="size-8" src="/poolstatis-logo.svg" alt="" /> Poolstatis
        </div>
        <div className="text-xs text-muted-foreground mt-1">Headless analytics admin</div>
      </div>
      <nav className="flex-1 px-3">
        <NavGroups />
      </nav>
      <ConnectionFooter />
    </aside>
  );
}

function MobileTopbar() {
  return (
    <header className="sticky top-0 z-30 flex min-h-14 items-center justify-between border-b bg-card/95 px-4 backdrop-blur-md md:hidden">
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
            <div className="mt-1 text-xs text-muted-foreground">Headless analytics admin</div>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="size-11" aria-label="Close navigation">
              <X className="size-4" />
            </Button>
          </DialogClose>
        </div>
        <nav className="flex-1 px-3">
          <NavGroups onNavigate={onNavigate} />
        </nav>
        <ConnectionFooter onDisconnect={onNavigate} />
      </aside>
    </DialogContent>
  );
}

function NavGroups({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      {NAV_GROUPS.map((g) => (
        <div key={g.label} className="mb-1">
          <div className="px-3 pt-3.5 pb-1.5 text-xs font-medium text-muted-foreground/70">{g.label}</div>
          {g.items.map(({ to, Icon, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onNavigate}
              className={({ isActive }) => cn('flex items-center gap-2.5 rounded-control px-3 py-2 text-sm transition-colors',
                isActive ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/65 hover:text-foreground')}
            >
              <Icon className="size-4" /> {label}
            </NavLink>
          ))}
        </div>
      ))}
    </>
  );
}

function ConnectionFooter({ onDisconnect }: { onDisconnect?: () => void }) {
  const { client, disconnect, tokenKind } = useStore();
  if (auth0Enabled && tokenKind === 'user') return <HostedConnectionFooter onDisconnect={onDisconnect} />;
  const handleDisconnect = () => {
    disconnect();
    onDisconnect?.();
  };
  return (
    <div className="mt-2 flex items-center justify-between border-t px-5 pt-3">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn('size-1.5 rounded-full', client ? 'bg-success' : 'bg-destructive')} /> {tokenKind ?? 'connected'} key
      </span>
      <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={handleDisconnect}>disconnect</Button>
    </div>
  );
}

function HostedConnectionFooter({ onDisconnect }: { onDisconnect?: () => void }) {
  const { client, disconnect } = useStore();
  const { logout } = useAuth0();
  const handleDisconnect = () => {
    disconnect();
    onDisconnect?.();
    logout({ logoutParams: { returnTo: window.location.origin } });
  };
  return (
    <div className="mt-2 flex items-center justify-between border-t px-5 pt-3">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn('size-1.5 rounded-full', client ? 'bg-success' : 'bg-destructive')} /> hosted auth
      </span>
      <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={handleDisconnect}>sign out</Button>
    </div>
  );
}

function Main() {
  const loc = useLocation();
  const { projects, project, setProject } = useStore();
  const reduceMotion = useReducedMotion();
  const title = titleFor(loc.pathname);
  const showProject = isProjectScoped(loc.pathname);

  return (
    <div className="min-h-0 md:h-dvh md:overflow-y-auto">
      <div className="sticky top-14 z-10 flex min-h-14 items-center border-b bg-card/90 px-4 py-3 backdrop-blur-md md:top-0 md:px-8">
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
          <span className="text-foreground">{title}</span>
        </div>
      </div>
      <motion.div className="w-full max-w-6xl p-4 pb-20 md:p-8" key={loc.pathname}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduceMotion ? 0 : 0.22, ease: 'easeOut' }}>
        <Routes>
          <Route path="/" element={<Projects />} />
          <Route path="/onboarding" element={<Onboarding />} />
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
      </motion.div>
    </div>
  );
}

function Guarded({ children }: { children: ReactNode }) {
  const { project } = useStore();
  if (!project) return <div className="flex flex-col items-center gap-2 py-14 text-center text-muted-foreground"><div className="serif text-xl text-foreground/70">No project selected</div><div>pick one on the Projects tab</div></div>;
  return <>{children}</>;
}
