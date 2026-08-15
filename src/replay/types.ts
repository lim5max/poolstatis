export const REPLAY_LIMITS = {
  maxChunkBytes: 512 * 1024,
  maxEventsPerChunk: 500,
  maxChunksPerSession: 120,
  maxEventsPerSession: 50_000,
  maxSessionBytes: 20 * 1024 * 1024,
  maxSessionDurationMs: 30 * 60 * 1000,
  maxViewerBytes: 20 * 1024 * 1024,
  maxViewerEvents: 50_000,
} as const;

export type ReplaySessionStatus =
  | 'recording'
  | 'playable'
  | 'incomplete'
  | 'deleting'
  | 'deleted';

export type ReplayTextMode = 'masked' | 'visible';

export interface ReplayPrivacyPolicy {
  version: string;
  text: ReplayTextMode;
  maskSelectors: string[];
  blockSelectors: string[];
}

export interface ReplayChunkDescriptor {
  sequence: number;
  checksum: string;
  byte_size: number;
  event_count: number;
  first_timestamp: number;
  last_timestamp: number;
  has_checkout: boolean;
}

export interface ReplaySessionSummary {
  id: string;
  surface: string;
  route: string;
  env: string;
  session_id: string;
  distinct_id: string;
  host: string;
  version: string;
  device: 'desktop' | 'mobile';
  consent_version: string;
  policy_version: string;
  text_mode: ReplayTextMode;
  status: ReplaySessionStatus;
  chunk_count: number;
  event_count: number;
  byte_size: number;
  started_at: string | Date;
  completed_at: string | Date | null;
  delete_after: string | Date;
  viewer_path: string;
}
