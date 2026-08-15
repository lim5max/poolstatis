import { lstat, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ReplayObjectStore {
  put(key: string, bytes: Buffer): Promise<'created' | 'existing'>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Atomic filesystem storage for self-host. Browser input never becomes a key. */
export class LocalReplayObjectStore implements ReplayObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, bytes: Buffer): Promise<'created' | 'existing'> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    try {
      // Hard-link creation is exclusive and atomic. A crash after link() but
      // before metadata commit leaves a recoverable deterministic object.
      await link(temporary, path);
      return 'created';
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new ReplayObjectConflictError();
      const existing = await readFile(path);
      if (!existing.equals(bytes)) throw new ReplayObjectConflictError();
      return 'existing';
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async get(key: string): Promise<Buffer> {
    const path = this.pathFor(key);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid replay object');
    return readFile(path);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private pathFor(key: string): string {
    if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}\/(?:[0-9]|[1-9][0-9]|1[01][0-9])\.json$/.test(key)) {
      throw new Error('invalid replay object key');
    }
    const path = resolve(join(this.root, key));
    if (!path.startsWith(`${this.root}${sep}`)) throw new Error('replay object path escapes root');
    return path;
  }
}

export class ReplayObjectConflictError extends Error {
  constructor() {
    super('replay object already exists with different bytes');
    this.name = 'ReplayObjectConflictError';
  }
}
