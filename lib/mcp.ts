// The Model Context Protocol surface: JSON-RPC 2.0 over POST /mcp, the legacy handshake
// (initialize + notifications/initialized) with no session id, and the six repository tools
// github-mcp-server's names describe. Every tool reads and writes the same store REST answers from.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { forge, VIEWER, scenario } from './db.ts';
import { readBody, sendError, sendJson } from './rest-shapes.ts';
import { buildCommit, flattenTree, putObject, resolveCommit, treeOf, type RepoRecord } from './store.ts';
import { buildTreeFromFiles } from './graphql.ts';

export interface McpCtx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly body: () => Promise<string>;
}

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly run: (args: Record<string, unknown>) => unknown;
}

const str = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');

/** The repository a tool call names, or a tool error saying which one is missing. */
function repoOf(args: Record<string, unknown>): RepoRecord {
  let owner = str(args, 'owner') || str(args, 'owner_login');
  let name = str(args, 'repo') || str(args, 'repository') || str(args, 'name');
  const full = str(args, 'full_name');
  if (full.includes('/') && (owner === '' || name === '')) {
    const [first, ...rest] = full.split('/');
    owner = first;
    name = rest.join('/');
  }
  const repo = forge.repo(owner, name);
  if (repo === null) throw new ToolError(`repository ${owner}/${name} was not found`);
  return repo;
}

class ToolError extends Error {}

const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the token holder.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'the repository name' },
        description: { type: 'string', description: 'a short description' },
        private: { type: 'boolean', description: 'whether the repository is private' },
      },
      required: ['name'],
    },
    run: (args) => {
      const name = str(args, 'name');
      if (name === '') throw new ToolError('name is required');
      const existing = forge.repo(VIEWER, name);
      const repo = existing ?? forge.createRepo(VIEWER, name, str(args, 'description'), args.private === true);
      return { owner: repo.owner, repo: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, description: repo.description, id: repo.id };
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const repo = repoOf(args);
      return {
        id: repo.id,
        owner: repo.owner,
        repo: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        description: repo.description,
        private: repo.private,
        default_branch: repo.defaultBranch,
      };
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (args) => {
      const repo = repoOf(args);
      const title = str(args, 'title');
      if (title === '') throw new ToolError('title is required');
      const now = forge.tick();
      repo.issueSeq += 1;
      const issue = { number: repo.issueSeq, title, body: str(args, 'body'), state: 'open' as const, labels: [], user: VIEWER, createdAt: now, updatedAt: now, closedAt: null };
      repo.issues.push(issue);
      return { number: issue.number, title: issue.title, body: issue.body, state: issue.state, owner: repo.owner, repo: repo.name };
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', description: 'open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
    run: (args) => {
      const repo = repoOf(args);
      const state = str(args, 'state') || 'open';
      const issues = [...repo.issues]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, body: issue.body }));
      return { issues, total: issues.length };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (args) => {
      const repo = repoOf(args);
      const head = str(args, 'head');
      const base = str(args, 'base');
      if (resolveCommit(repo, head) === null) throw new ToolError(`head branch ${head} does not exist`);
      if (resolveCommit(repo, base) === null) throw new ToolError(`base branch ${base} does not exist`);
      const now = forge.tick();
      repo.pullSeq += 1;
      const pull = { number: repo.pullSeq, title: str(args, 'title'), body: str(args, 'body'), head, base, state: 'open' as const, user: VIEWER, createdAt: now, updatedAt: now, mergedAt: null, mergeSha: null };
      repo.pulls.push(pull);
      return { number: pull.number, title: pull.title, state: pull.state, head, base, merged: false };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (args) => {
      const repo = repoOf(args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(str(args, 'pull_number'), 10);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) throw new ToolError(`pull request #${number} was not found`);
      if (pull.mergedAt !== null) return { number, merged: true, sha: pull.mergeSha };
      const headOid = resolveCommit(repo, pull.head);
      const baseOid = resolveCommit(repo, pull.base);
      if (headOid === null || baseOid === null) throw new ToolError('the pull request has no head or base commit');
      const headTree = treeOf(repo, headOid);
      const baseTree = treeOf(repo, baseOid);
      const files = new Map<string, string>(baseTree === null ? [] : flattenTree(repo, baseTree));
      if (headTree !== null) for (const [path, content] of flattenTree(repo, headTree)) files.set(path, content);
      const tree = buildTreeFromFiles(repo, files);
      const person = { name: scenario.viewer.name, email: scenario.viewer.email, date: forge.tick() };
      const body = buildCommit(tree, [baseOid], person, person, `Merge pull request #${pull.number}: ${pull.title}`);
      const sha = putObject(repo, 'commit', body);
      repo.refs.set(`refs/heads/${pull.base}`, sha);
      pull.state = 'closed';
      pull.mergedAt = forge.tick();
      pull.mergeSha = sha;
      pull.updatedAt = pull.mergedAt;
      return { number, merged: true, sha, state: 'closed' };
    },
  },
];

/** The protocol revision the client asked for, when it declared one in `_meta`. */
function requestedVersion(params: Record<string, unknown> | null): string | null {
  const meta = params === null ? undefined : params._meta;
  if (typeof meta !== 'object' || meta === null) return null;
  const version = (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'];
  return typeof version === 'string' ? version : null;
}

interface RpcRequest {
  readonly id: unknown;
  readonly method: string;
  readonly params: Record<string, unknown> | null;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleRpc(request: RpcRequest): { body: Record<string, unknown>; status: number } | null {
  if (request.method === 'initialize') {
    const asked = typeof request.params?.protocolVersion === 'string' ? (request.params.protocolVersion as string) : SUPPORTED_VERSIONS[0];
    const version = requestedVersion(request.params) ?? asked;
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(version) ? version : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
          serverInfo: { name: 'forge-mcp', version: '0.1.0' },
          instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
        },
      },
    };
  }
  if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return null;
  if (request.method === 'ping') return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: {} } };
  if (request.method === 'tools/list') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        },
      },
    };
  }
  if (request.method === 'tools/call') {
    const name = typeof request.params?.name === 'string' ? (request.params.name as string) : '';
    const args = typeof request.params?.arguments === 'object' && request.params.arguments !== null ? (request.params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) return { status: 200, body: rpcError(request.id, -32602, `unknown tool: ${name}`) };
    const required = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : [];
    const missing = required.filter((key) => !(key in args));
    if (missing.length > 0) {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: request.id,
          result: { content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }], isError: true },
        },
      };
    }
    try {
      const value = tool.run(args);
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            structuredContent: value,
            isError: false,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: message }], isError: true } } };
    }
  }
  if (request.method === 'resources/list') return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: { resources: [] } } };
  if (request.method === 'prompts/list') return { status: 200, body: { jsonrpc: '2.0', id: request.id, result: { prompts: [] } } };
  return { status: 200, body: rpcError(request.id, -32601, `method not found: ${request.method}`) };
}

/** Answer one MCP request, or false when the path is not /mcp. */
export async function handleMcp(ctx: McpCtx): Promise<boolean> {
  const { req, res, method, segments } = ctx;
  if (segments.length < 1 || segments[0] !== 'mcp') return false;
  if (method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  const token = (req.headers.authorization ?? '').toString().replace(/^Bearer\s+/i, '').trim();
  if (token === '') {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await ctx.body());
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  const requests: Array<Record<string, unknown>> = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [parsed as Record<string, unknown>];
  const answers: Array<Record<string, unknown>> = [];
  for (const entry of requests) {
    if (typeof entry !== 'object' || entry === null || typeof entry.method !== 'string') {
      answers.push(rpcError(null, -32600, 'Invalid Request'));
      continue;
    }
    const request: RpcRequest = {
      id: entry.id ?? null,
      method: entry.method as string,
      params: typeof entry.params === 'object' && entry.params !== null ? (entry.params as Record<string, unknown>) : null,
    };
    const answer = handleRpc(request);
    if (answer !== null) answers.push(answer.body);
  }
  if (answers.length === 0) {
    res.writeHead(202, { 'content-length': '0' });
    res.end();
    return true;
  }
  sendJson(res, 200, Array.isArray(parsed) ? answers : answers[0]);
  return true;
}