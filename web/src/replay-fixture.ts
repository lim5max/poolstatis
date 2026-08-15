import { ReplayRecorder } from '../../sdk/src/replay.ts';

const status = document.querySelector<HTMLOutputElement>('#status')!;
const start = document.querySelector<HTMLButtonElement>('#start')!;
const mutate = document.querySelector<HTMLButtonElement>('#mutate')!;
const stop = document.querySelector<HTMLButtonElement>('#stop')!;
let recorder: ReplayRecorder | null = null;
let replayId: string | null = null;

start.addEventListener('click', async () => {
  const ingestKey = localStorage.getItem('poolstatis.replay.e2e-key');
  if (!ingestKey) {
    status.value = 'error:missing-key';
    return;
  }
  start.disabled = true;
  status.value = 'starting';
  try {
    recorder = new ReplayRecorder({
      url: '',
      ingestKey,
      surface: 'workspace',
      route: 'workspace',
      distinctId: 'browser-e2e-actor',
      version: 'browser-e2e-v1',
      consent: { granted: true, version: 'browser-e2e-consent-v1' },
      policy: { version: 'browser-e2e-privacy-v1', text: 'masked' },
      allowedHosts: [window.location.hostname],
      retentionDays: 1,
      onError: (error) => { status.value = `error:${error instanceof Error ? error.message : 'unknown'}`; },
    });
    const result = await recorder.start();
    replayId = result.replayId;
    status.value = `recording:${replayId}`;
    mutate.disabled = false;
    stop.disabled = false;
  } catch (error) {
    status.value = `error:${error instanceof Error ? error.message : 'unknown'}`;
    start.disabled = false;
  }
});

mutate.addEventListener('click', () => {
  const target = document.querySelector('#target')!;
  target.textContent = 'Changed private state for alice@example.test';
  const output = document.createElement('output');
  output.textContent = 'Mutation completed for Bearer secret-token-value';
  target.appendChild(output);
  mutate.disabled = true;
});

stop.addEventListener('click', async () => {
  if (!recorder || !replayId) return;
  stop.disabled = true;
  status.value = 'completing';
  try {
    await recorder.stop();
    status.value = `complete:${replayId}`;
  } catch (error) {
    status.value = `error:${error instanceof Error ? error.message : 'unknown'}`;
  }
});
