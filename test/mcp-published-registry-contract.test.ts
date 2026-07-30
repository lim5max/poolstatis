import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_PACKAGE_SPEC } from '../src/config.js';
import { PUBLISHED_MCP_TOOL_GROUPS } from '../web/src/mcpPublishedContract.js';

const verifyPublishedPackage = process.env.POOLSTATIS_VERIFY_PUBLISHED_MCP === 'true';
const suite = verifyPublishedPackage ? describe : describe.skip;

suite('published MCP registry contract', () => {
  let client: Client;
  let stderr = '';

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: 'pnpm',
      args: ['--silent', 'dlx', MCP_PACKAGE_SPEC],
      env: {
        PATH: process.env.PATH ?? '',
        POOLSTATIS_URL: 'http://127.0.0.1:1',
        POOLSTATIS_TOKEN: 'sk_0123456789abcdef',
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk) => {
      stderr += Buffer.from(chunk).toString('utf8');
    });
    client = new Client(
      { name: 'poolstatis-published-contract', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport, { timeout: 30_000 });
  });

  afterAll(async () => {
    await client?.close();
  });

  it('keeps every Setup tool inside the exact pinned registry package', async () => {
    const result = await client.listTools();
    const registryTools = new Set(result.tools.map((tool) => tool.name));
    const setupTools = PUBLISHED_MCP_TOOL_GROUPS.flatMap(([, tools]) => tools);
    const requiredBySkills = new Set<string>();
    for (const skill of ['poolstatis-instrument', 'poolstatis-analyze', 'poolstatis-maintain']) {
      const content = await readFile(
        resolve(import.meta.dirname, '..', '.agents', 'skills', skill, 'SKILL.md'),
        'utf8',
      );
      const contract = content.match(/<!-- published-mcp-required: ([a-z0-9_,]+) -->/);
      expect(contract, `${skill} must declare its published MCP requirements`).not.toBeNull();
      for (const tool of contract?.[1]?.split(',') ?? []) requiredBySkills.add(tool);
    }

    expect(client.getServerVersion()).toMatchObject({ version: '0.2.0' });
    expect(result.tools).toHaveLength(78);
    expect(setupTools.every((tool) => registryTools.has(tool))).toBe(true);
    expect([...requiredBySkills].every((tool) => registryTools.has(tool))).toBe(true);
    expect(stderr).toBe('');
  });
});
