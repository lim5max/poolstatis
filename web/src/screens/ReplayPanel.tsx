import { useEffect, useRef, useState } from 'react';
import type { Replayer as RrwebReplayer } from '@rrweb/replay';
import type { eventWithTime } from '@rrweb/types';
import '@rrweb/replay/dist/style.css';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, ErrorNote, Panel, TableScroll, fmtNum } from '@/components/ui';
import type { ReplaySessionSummary } from '@/api/types';
import { useAsync, useStore } from '@/store';

export function ReplayPanel() {
  const { client, project, env } = useStore();
  const { data, error, loading, reload } = useAsync(
    () => typeof client?.sessionReplays === 'function'
      ? client.sessionReplays(project!, { env, limit: 50 })
      : Promise.resolve([]),
    [project, env],
  );
  const search = new URLSearchParams(window.location.search);
  const requested = search.get('replay');
  const requestedEnv = search.get('env') ?? env;
  const requestedReplay = useAsync(
    () => requested && typeof client?.sessionReplay === 'function'
      ? client.sessionReplay(project!, requested, requestedEnv)
      : Promise.resolve(null),
    [client, project, requested, requestedEnv],
  );
  const [selectedId, setSelectedId] = useState<string | null>(requested);
  const selected = data?.find((replay) => replay.id === selectedId)
    ?? (requestedReplay.data?.id === selectedId ? requestedReplay.data : null);
  const [events, setEvents] = useState<Array<Record<string, unknown>> | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [playerLoading, setPlayerLoading] = useState(false);

  useEffect(() => {
    if (!selected || selected.status !== 'playable') {
      setEvents(null);
      setPlayerLoading(false);
      return;
    }
    let active = true;
    setEvents(null);
    setPlayerError(null);
    setPlayerLoading(true);
    client!.sessionReplayEvents(project!, selected.id, selected.env)
      .then((response) => { if (active) setEvents(response.events); })
      .catch((caught) => {
        if (active) setPlayerError(caught instanceof Error ? caught.message : 'Replay payload could not be loaded.');
      })
      .finally(() => { if (active) setPlayerLoading(false); });
    return () => { active = false; };
  }, [client, project, selected]);

  return (
    <Panel
      title="Session replays"
      right={<span className="text-sm text-muted-foreground">explicit opt-in · masked DOM · 7-day default</span>}
    >
      <div className="space-y-4">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Real DOM mutation and pointer playback is separate from aggregate Experience maps. Only consented,
          host-allowed recordings appear here; passwords, form values, contenteditable text and human-readable
          attributes are masked before upload and validated again on the server.
        </p>
        {loading && <div role="status" className="py-8 text-center text-sm text-muted-foreground">Loading session replays…</div>}
        {error && <div className="space-y-3"><ErrorNote>{error}</ErrorNote><Button variant="outline" size="sm" onClick={reload}>Try again</Button></div>}
        {requestedReplay.error && selectedId === requested && <ErrorNote>{requestedReplay.error}</ErrorNote>}
        {!loading && !error && data?.length === 0 && (
          <EmptyState
            headline="No consented replays yet"
            lead="Install the separate @poolstatis/sdk/replay entrypoint and enable it only after your consent and host-policy gates pass."
          />
        )}
        {!loading && !error && data && data.length > 0 && (
          <TableScroll testId="session-replay-table">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Started</TableHead><TableHead>Surface / route</TableHead><TableHead>Device</TableHead>
                <TableHead>Status</TableHead><TableHead className="text-right">Events</TableHead><TableHead />
              </TableRow></TableHeader>
              <TableBody>{data.map((replay) => (
                <TableRow key={replay.id} data-state={selectedId === replay.id ? 'selected' : undefined}>
                  <TableCell className="whitespace-nowrap text-sm">{formatDate(replay.started_at)}</TableCell>
                  <TableCell><div className="font-medium">{replay.surface}</div><div className="font-mono text-xs text-muted-foreground">{replay.route} · {replay.version}</div></TableCell>
                  <TableCell className="capitalize">{replay.device}</TableCell>
                  <TableCell><ReplayStatus replay={replay} /></TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{fmtNum(replay.event_count)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant={selectedId === replay.id ? 'secondary' : 'outline'}
                      disabled={replay.status !== 'playable'}
                      onClick={() => setSelectedId(replay.id)}
                    >Watch</Button>
                  </TableCell>
                </TableRow>
              ))}</TableBody>
            </Table>
          </TableScroll>
        )}
        {selected && selected.status === 'playable' && (
          <div className="space-y-3 border-t pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><div className="font-medium">{selected.surface} / {selected.route}</div><div className="font-mono text-xs text-muted-foreground">{selected.id}</div></div>
              <span className="text-xs text-muted-foreground">Recorded DOM remains untrusted inside rrweb’s scriptless sandbox.</span>
            </div>
            {playerLoading && <div role="status" className="grid min-h-72 place-items-center rounded-md border bg-muted/30 text-sm text-muted-foreground">Loading bounded recording…</div>}
            {playerError && <ErrorNote>{playerError}</ErrorNote>}
            {events && <ReplayFrame replayId={selected.id} events={events} onError={setPlayerError} />}
          </div>
        )}
      </div>
    </Panel>
  );
}

function ReplayStatus({ replay }: { replay: ReplaySessionSummary }) {
  const variant = replay.status === 'playable' ? 'default' : replay.status === 'incomplete' ? 'destructive' : 'secondary';
  return <Badge variant={variant} className="capitalize">{replay.status}</Badge>;
}

function ReplayFrame({ replayId, events, onError }: {
  replayId: string;
  events: Array<Record<string, unknown>>;
  onError: (message: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const replayer = useRef<RrwebReplayer | null>(null);
  const [ready, setReady] = useState(false);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    let active = true;
    setReady(false);
    root.current?.replaceChildren();
    void import('@rrweb/replay').then(({ Replayer }) => {
      if (!active || !root.current) return;
      const instance = new Replayer(events as eventWithTime[], {
        root: root.current,
        UNSAFE_replayCanvas: false,
        mouseTail: { duration: 300, lineWidth: 2, strokeStyle: '#4b50f6' },
        skipInactive: true,
        showWarning: false,
        showDebug: false,
        triggerFocus: false,
        loadTimeout: 0,
        plugins: [],
      });
      if (instance.iframe.getAttribute('sandbox') !== 'allow-same-origin') {
        instance.destroy();
        throw new Error('rrweb replay iframe did not use the required scriptless sandbox');
      }
      instance.iframe.title = `Session replay content ${replayId}`;
      instance.disableInteract();
      replayer.current = instance;
      setReady(true);
    }).catch((error) => {
      if (active) onError(error instanceof Error ? error.message : 'Replay could not be rendered.');
    });
    return () => {
      active = false;
      replayer.current?.destroy();
      replayer.current = null;
    };
  }, [events, onError, replayId]);

  const command = (kind: 'play' | 'pause') => {
    if (kind === 'play') replayer.current?.play();
    else replayer.current?.pause();
  };
  const changeSpeed = (next: number) => {
    setSpeed(next);
    replayer.current?.setConfig({ speed: next });
  };

  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={!ready} onClick={() => command('play')}>Play</Button>
      <Button size="sm" variant="outline" disabled={!ready} onClick={() => command('pause')}>Pause</Button>
      {[0.5, 1, 2, 4].map((item) => <Button key={item} size="sm" variant={speed === item ? 'secondary' : 'ghost'} disabled={!ready} onClick={() => changeSpeed(item)}>{item}×</Button>)}
      {!ready && <span role="status" className="text-xs text-muted-foreground">Preparing sandbox…</span>}
    </div>
    <div ref={root} role="region" aria-label={`Session replay ${replayId}`} className="h-96 w-full overflow-auto rounded-md border bg-muted/30 p-3" />
  </div>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
