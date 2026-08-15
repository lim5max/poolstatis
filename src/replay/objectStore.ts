import { constants } from 'node:fs';
import { lstat, link, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ReplayObjectStore {
  put(key: string, bytes: Buffer): Promise<'created' | 'existing'>;
  get(key: string, maxBytes?: number): Promise<Buffer>;
  delete(key: string): Promise<void>;
  deleteReplay(projectId: string, replayId: string): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
}

/** Atomic filesystem storage for self-host. Browser input never becomes a key. */
export class LocalReplayObjectStore implements ReplayObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, bytes: Buffer): Promise<'created' | 'existing'> {
    const path = this.pathFor(key);
    await this.ensureSafeParent(key);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    try {
      // Hard-link creation is exclusive and atomic. A crash after link() but
      // before metadata commit leaves a recoverable deterministic object.
      await link(temporary, path);
      return 'created';
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      let existing: Buffer;
      try {
        existing = await readBoundedFile(path, bytes.length);
      } catch {
        throw new ReplayObjectConflictError();
      }
      if (!existing.equals(bytes)) throw new ReplayObjectConflictError();
      return 'existing';
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async get(key: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<Buffer> {
    const path = this.pathFor(key);
    await this.assertSafeParent(key);
    return readBoundedFile(path, maxBytes);
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await this.assertSafeParent(key);
    await rm(path, { force: true });
  }

  async deleteReplay(projectId: string, replayId: string): Promise<void> {
    const directory = this.replayDirectory(projectId, replayId);
    try {
      await this.assertRootAndProject(projectId);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return;
      throw error;
    }
    try {
      await assertDirectory(directory);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return;
      throw error;
    }
    await rm(directory, { recursive: true, force: true });
  }

  async deleteProject(projectId: string): Promise<void> {
    const directory = this.projectDirectory(projectId);
    try {
      await assertDirectory(this.root);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return;
      throw error;
    }
    try {
      await assertDirectory(directory);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return;
      throw error;
    }
    await rm(directory, { recursive: true, force: true });
  }

  private async ensureSafeParent(key: string): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertDirectory(this.root);
    const parts = key.split('/').slice(0, -1);
    let current = this.root;
    for (const part of parts) {
      current = join(current, part);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
      }
      await assertDirectory(current);
    }
  }

  private async assertSafeParent(key: string): Promise<void> {
    await assertDirectory(this.root);
    const parts = key.split('/').slice(0, -1);
    let current = this.root;
    for (const part of parts) {
      current = join(current, part);
      await assertDirectory(current);
    }
  }

  private pathFor(key: string): string {
    const parts = key.split('/');
    if (parts.length !== 3
        || !UUID.test(parts[0]!)
        || !UUID.test(parts[1]!)
        || !/^(?:[0-9]|[1-9][0-9]|1[01][0-9])\.json$/.test(parts[2]!)) {
      throw new Error('invalid replay object key');
    }
    const path = resolve(join(this.root, key));
    if (!path.startsWith(`${this.root}${sep}`)) throw new Error('replay object path escapes root');
    return path;
  }

  private replayDirectory(projectId: string, replayId: string): string {
    assertUuid(projectId);
    assertUuid(replayId);
    return resolve(join(this.projectDirectory(projectId), replayId));
  }

  private projectDirectory(projectId: string): string {
    assertUuid(projectId);
    const directory = resolve(join(this.root, projectId));
    if (!directory.startsWith(`${this.root}${sep}`)) throw new Error('replay object path escapes root');
    return directory;
  }

  private async assertRootAndProject(projectId: string): Promise<void> {
    await assertDirectory(this.root);
    await assertDirectory(this.projectDirectory(projectId));
  }
}

export class ReplayObjectConflictError extends Error {
  constructor() {
    super('replay object already exists with different bytes');
    this.name = 'ReplayObjectConflictError';
  }
}

export class ReplayObjectTooLargeError extends Error {
  constructor() {
    super('replay object exceeds its bounded manifest size');
    this.name = 'ReplayObjectTooLargeError';
  }
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid replay object directory');
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new ReplayObjectTooLargeError();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('invalid replay object');
    if (info.size > maxBytes) throw new ReplayObjectTooLargeError();
    const output = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < output.length) {
      const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
      if (bytesRead === 0) throw new Error('replay object was truncated while reading');
      offset += bytesRead;
    }
    return output;
  } finally {
    await handle.close();
  }
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new Error('invalid replay object identifier');
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
