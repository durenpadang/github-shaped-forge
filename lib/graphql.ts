// GraphQL v4: the relay shape gh reads. A small engine — it parses the document's selection sets, resolves
// them against the store, and reports unknown fields the way GitHub does: HTTP 200 with an errors array.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { forge, VIEWER, scenario } from './db.ts';
import { readBody, sendError, sendJson } from './rest-shapes.ts';
import {
  buildCommit,
  flattenTree,
  getObject,
  parseTree,
  putObject,
  resolveCommit,
  treeOf,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';

export interface GqlCtx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly body: () => Promise<string>;
}

interface Sel {
  readonly name: string;
  readonly alias: string;
  readonly args: string;
  readonly sel: Sel[];
}

class GqlError extends Error {}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const gid = (kind: string, ...parts: Array<string | number>): string =>
  Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');

function ungid(id: string): { kind: string; parts: string[] } {
  const text = Buffer.from(id, 'base64').toString('utf8');
  const [kind, ...parts] = text.split(':');
  return { kind, parts };
}

// ---------------------------------------------------------------------------------------------------
// The document parser
// ---------------------------------------------------------------------------------------------------

class Scanner {
  text: string;
  pos = 0;
  constructor(text: string) {
    this.text = text;
  }

  skip(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',' || ch === '\ufeff') this.pos += 1;
      else if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
      } else break;
    }
  }

  peek(): string {
    this.skip();
    return this.text[this.pos] ?? '';
  }

  name(): string {
    this.skip();
    const start = this.pos;
    while (this.pos < this.text.length && /[A-Za-z0-9_]/.test(this.text[this.pos])) this.pos += 1;
    return this.text.slice(start, this.pos);
  }

  balanced(open: string, close: string): string {
    this.skip();
    if (this.text[this.pos] !== open) return '';
    const start = this.pos;
    let depth = 0;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          this.pos += 1;
          return this.text.slice(start + 1, this.pos - 1);
        }
      } else if (ch === '"') {
        this.pos += 1;
        while (this.pos < this.text.length && this.text[this.pos] !== '"') {
          if (this.text[this.pos] === '\\') this.pos += 1;
          this.pos += 1;
        }
      }
      this.pos += 1;
    }
    throw new GqlError('unbalanced selection');
  }

  selectionSet(): Sel[] {
    this.skip();
    if (this.text[this.pos] !== '{') throw new GqlError(`expected a selection set at ${this.pos}`);
    this.pos += 1;
    const out: Sel[] = [];
    for (;;) {
      const ch = this.peek();
      if (ch === '') throw new GqlError('unterminated selection set');
      if (ch === '}') {
        this.pos += 1;
        return out;
      }
      if (ch === '.') {
        // `... on Type { fields }`: the fields belong to this selection too
        while (this.pos < this.text.length && this.text[this.pos] !== '{') this.pos += 1;
        if (this.text[this.pos] === '{') {
          const start = this.pos;
          const inner = this.balanced('{', '}');
          const scanner2 = new Scanner(`{${inner}}`);
          for (const field of scanner2.selectionSet()) out.push(field);
          void start;
        }
        continue;
      }
      const first = this.name();
      if (first === '') {
        this.pos += 1;
        continue;
      }
      let alias = '';
      let name = first;
      if (this.peek() === ':') {
        this.pos += 1;
        alias = first;
        name = this.name();
      }
      const args = this.peek() === '(' ? this.balanced('(', ')') : '';
      const sel = this.peek() === '{' ? this.selectionSet() : [];
      out.push({ name, alias: alias === '' ? name : alias, args, sel });
    }
  }
}

interface Document {
  readonly op: 'query' | 'mutation';
  readonly sels: Sel[];
}

function parseDocument(text: string): Document {
  const scanner = new Scanner(text);
  let op: 'query' | 'mutation' = 'query';
  const head = scanner.name();
  if (head === 'mutation' || head === 'query' || head === 'subscription') {
    op = head === 'mutation' ? 'mutation' : 'query';
    scanner.skip();
    if (/[A-Za-z_]/.test(scanner.peek())) scanner.name();
    if (scanner.peek() === '(') scanner.balanced('(', ')');
  }
  const sels = scanner.selectionSet();
  return { op, sels };
}

/** Read one argument's raw text by name from an argument block. */
function argRaw(args: string, name: string): string | null {
  if (args === '') return null;
  const scanner = new Scanner(args);
  for (;;) {
    const key = scanner.name();
    if (key === '') return null;
    if (scanner.peek() !== ':') return null;
    scanner.pos += 1;
    scanner.skip();
    let value: string;
    if (scanner.peek() === '[' || scanner.peek() === '{') {
      const open = scanner.peek();
      value = open + scanner.balanced(open, open === '[' ? ']' : '}') + (open === '[' ? ']' : '}');
    } else if (scanner.peek() === '"') {
      const start = scanner.pos;
      scanner.pos += 1;
      while (scanner.pos < args.length && args[scanner.pos] !== '"') {
        if (args[scanner.pos] === '\\') scanner.pos += 1;
        scanner.pos += 1;
      }
      scanner.pos += 1;
      value = args.slice(start, scanner.pos);
    } else {
      const start = scanner.pos;
      while (scanner.pos < args.length && !/[,)\s]/.test(args[scanner.pos])) scanner.pos += 1;
      value = args.slice(start, scanner.pos);
    }
    if (key === name) return value;
  }
}

/** A field's value as a JS value: variables, literals, lists and objects. */
function argValue(args: string, name: string, variables: Record<string, unknown>): unknown {
  const raw = argRaw(args, name);
  if (raw === null) return undefined;
  const text = raw.trim();
  if (text.startsWith('$')) return variables[text.slice(1)];
  if (text.startsWith('"')) return text.slice(1, -1);
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.startsWith('[')) {
    return text
      .slice(1, -1)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => (part.startsWith('$') ? variables[part.slice(1)] : part.replace(/"/g, '')));
  }
  if (text.startsWith('{')) {
    const out: Record<string, unknown> = {};
    const inner = text.slice(1, -1);
    for (const part of inner.split(',')) {
      const [key, ...rest] = part.split(':');
      if (key === undefined || rest.length === 0) continue;
      out[key.trim()] = rest.join(':').trim().replace(/"/g, '');
    }
    return out;
  }
  return text;
}

// ---------------------------------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------------------------------

type Resolver = (args: string, variables: Record<string, unknown>) => unknown;
type Node = Record<string, unknown>;

const personOf = (login: string): Node => {
  if (login === VIEWER) return { login, id: gid('User', VIEWER), name: scenario.viewer.name, databaseId: scenario.viewer.id };
  for (const candidate of [scenario.teammate, scenario.stranger]) {
    if (candidate.login === login) return { login, id: gid('User', candidate.login), name: candidate.name, databaseId: candidate.id };
  }
  return { login, id: gid('User', login), name: login, databaseId: 1 };
};

function connection(items: readonly Node[], args: string, variables: Record<string, unknown>, cursorOf: (node: Node) => number): Node {
  const first = argValue(args, 'first', variables);
  const after = argValue(args, 'after', variables);
  let list = [...items];
  if (typeof after === 'string' && after !== '') {
    const cursor = Number.parseInt(Buffer.from(after, 'base64').toString('utf8').replace('cursor:', ''), 10);
    if (Number.isFinite(cursor)) list = list.filter((node) => cursorOf(node) < cursor);
  }
  const size = typeof first === 'number' ? first : list.length;
  const page = list.slice(0, Math.max(0, size));
  const last = page[page.length - 1];
  return {
    nodes: page,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: list.length > page.length,
      hasPreviousPage: items.length !== list.length,
      endCursor: last === undefined ? null : Buffer.from(`cursor:${cursorOf(last)}`, 'utf8').toString('base64'),
      startCursor: page.length === 0 ? null : Buffer.from(`cursor:${cursorOf(page[0])}`, 'utf8').toString('base64'),
    },
  };
}

function issueNode(repo: RepoRecord, issue: IssueRecord): Node {
  const comments = repo.comments.filter((comment) => comment.issueNumber === issue.number);
  return {
    __typename: 'Issue',
    id: gid('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    stateReason: issue.state === 'closed' ? 'COMPLETED' : null,
    createdAt: iso(issue.createdAt),
    updatedAt: iso(issue.updatedAt),
    closedAt: issue.closedAt === null ? null : iso(issue.closedAt),
    url: `http://127.0.0.1/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author: personOf(issue.user),
    labels: {
      nodes: issue.labels.map((name) => ({ __typename: 'Label', id: gid('Label', repo.id, name), name, color: 'ededed' })),
      totalCount: issue.labels.length,
    },
    comments: {
      nodes: comments.map((comment) => ({
        __typename: 'IssueComment',
        id: gid('IssueComment', comment.id),
        body: comment.body,
        createdAt: iso(comment.createdAt),
        author: personOf(comment.user),
      })),
      totalCount: comments.length,
      pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null },
    },
  };
}

function pullFiles(repo: RepoRecord, pull: PullRecord): Array<{ path: string; status: string }> {
  const baseOid = resolveCommit(repo, pull.base);
  const headOid = resolveCommit(repo, pull.head);
  if (baseOid === null || headOid === null) return [];
  const baseTree = treeOf(repo, baseOid);
  const headTree = treeOf(repo, headOid);
  if (baseTree === null || headTree === null) return [];
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const out: Array<{ path: string; status: string }> = [];
  for (const path of head.keys()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before === after) continue;
    out.push({ path, status: before === undefined ? 'ADDED' : 'MODIFIED' });
  }
  for (const path of base.keys()) if (!head.has(path)) out.push({ path, status: 'DELETED' });
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function pullNode(repo: RepoRecord, pull: PullRecord): Node {
  const merged = pull.mergedAt !== null;
  const files = pullFiles(repo, pull);
  return {
    __typename: 'PullRequest',
    id: gid('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged,
    mergedAt: pull.mergedAt === null ? null : iso(pull.mergedAt),
    mergeCommit: pull.mergeSha === null ? null : { __typename: 'Commit', oid: pull.mergeSha },
    headRefName: pull.head,
    baseRefName: pull.base,
    headRefOid: resolveCommit(repo, pull.head),
    baseRefOid: resolveCommit(repo, pull.base),
    isDraft: false,
    mergeable: 'MERGEABLE',
    createdAt: iso(pull.createdAt),
    updatedAt: iso(pull.updatedAt),
    url: `http://127.0.0.1/${repo.owner}/${repo.name}/pull/${pull.number}`,
    author: personOf(pull.user),
    files: {
      nodes: files.map((file) => ({
        __typename: 'PullRequestChangedFile',
        path: file.path,
        additions: 1,
        deletions: 0,
        changeType: file.status,
      })),
      totalCount: files.length,
      pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null },
    },
    comments: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null } },
  };
}

function repoNode(repo: RepoRecord): Node {
  const headOid = resolveCommit(repo, repo.defaultBranch);
  const issues = [...repo.issues].sort((a, b) => b.number - a.number);
  const pulls = [...repo.pulls].sort((a, b) => b.number - a.number);
  const filtered = (args: string, variables: Record<string, unknown>, list: readonly IssueRecord[], pulls: boolean): Node[] => {
    const states = argValue(args, 'states', variables);
    const stateText = Array.isArray(states) ? states.map(String) : ['OPEN'];
    const node = (entry: IssueRecord): Node => (pulls ? pullNode(repo, entry as unknown as PullRecord) : issueNode(repo, entry));
    return list.filter((entry) => stateText.includes(entry.state === 'open' ? 'OPEN' : 'CLOSED')).map(node);
  };
  return {
    __typename: 'Repository',
    id: gid('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    isFork: false,
    isEmpty: repo.refs.size === 0,
    createdAt: iso(repo.createdAt),
    updatedAt: iso(repo.pushedAt),
    pushedAt: iso(repo.pushedAt),
    url: `http://127.0.0.1/${repo.owner}/${repo.name}`,
    owner: personOf(repo.owner),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    hasPullRequestsEnabled: true,
    defaultBranchRef: headOid === null ? null : { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'Commit', oid: headOid } },
    issue: ((args: string, variables: Record<string, unknown>) => {
      const number = argValue(args, 'number', variables);
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue === undefined ? null : issueNode(repo, issue);
    }) as unknown as Resolver,
    issues: ((args: string, variables: Record<string, unknown>) =>
      connection(
        filtered(args, variables, issues, false),
        args,
        variables,
        (node) => Number(node.number),
      )) as unknown as Resolver,
    pullRequest: ((args: string, variables: Record<string, unknown>) => {
      const number = argValue(args, 'number', variables);
      const pull = repo.pulls.find((entry) => entry.number === number);
      return pull === undefined ? null : pullNode(repo, pull);
    }) as unknown as Resolver,
    pullRequests: ((args: string, variables: Record<string, unknown>) =>
      connection(
        filtered(args, variables, pulls as unknown as IssueRecord[], true),
        args,
        variables,
        (node) => Number(node.number),
      )) as unknown as Resolver,
    ref: ((args: string, variables: Record<string, unknown>) => {
      const name = argValue(args, 'qualifiedName', variables);
      const oid = resolveCommit(repo, String(name).replace(/^refs\/heads\//, ''));
      return oid === null ? null : { __typename: 'Ref', name: String(name), target: { __typename: 'Commit', oid } };
    }) as unknown as Resolver,
    labels: { nodes: repo.labels.map((name) => ({ __typename: 'Label', id: gid('Label', repo.id, name), name, color: 'ededed' })), totalCount: repo.labels.length },
    assignableUsers: { nodes: [personOf(VIEWER)], totalCount: 1 },
  };
}

const SCHEMA: Record<string, string[]> = {
  User: ['id', 'login', 'name', 'email', 'databaseId', 'avatarUrl', 'url', 'bio', 'company', 'createdAt'],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'stateReason', 'createdAt', 'updatedAt', 'closedAt', 'url', 'author',
    'labels', 'comments', 'assignees', 'milestone', 'closed', 'isPinned', 'projectItems', 'trackedInIssues',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'isDraft', 'mergeable', 'createdAt', 'updatedAt', 'url', 'author', 'files',
    'comments', 'commits', 'reviews', 'reviewDecision', 'additions', 'deletions', 'changedFiles',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'isFork', 'isEmpty', 'createdAt',
    'updatedAt', 'pushedAt', 'url', 'owner', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled',
    'defaultBranchRef', 'issue', 'issues', 'pullRequest', 'pullRequests', 'ref', 'labels', 'assignableUsers',
    'object', 'milestones', 'releases', 'stargazerCount',
  ],
  SearchType: [],
  IssueComment: ['id', 'body', 'createdAt', 'author', 'url'],
};

function introspection(typeName: string): Node {
  const fields = SCHEMA[typeName];
  if (fields === undefined) throw new GqlError(`No such type: ${typeName}`);
  if (typeName === 'SearchType') {
    return { __typename: '__Type', name: typeName, fields: [], enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'].map((name) => ({ __typename: '__EnumValue', name })) };
  }
  return { __typename: '__Type', name: typeName, fields: fields.map((name) => ({ __typename: '__Field', name })), enumValues: [] };
}

// ---------------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------------

function resolveValue(value: unknown, sel: Sel[], variables: Record<string, unknown>, path: string[]): unknown {
  if (sel.length === 0) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, sel, variables, path));
  if (typeof value !== 'object') return value;
  const node = value as Node;
  const out: Node = {};
  for (const field of sel) {
    let raw = node[field.name];
    if (raw === undefined && field.name === '__typename') raw = '__Type';
    if (raw === undefined) {
      if (field.name === '__typename') raw = node.__typename ?? '__Type';
      else throw new GqlError(`Field '${field.name}' doesn't exist on type '${String(node.__typename ?? 'Object')}'`);
    }
    const resolved = typeof raw === 'function' ? (raw as Resolver)(field.args, variables) : raw;
    out[field.alias] = resolveValue(resolved, field.sel, variables, [...path, field.name]);
  }
  return out;
}

/** The repository an id names, or null. */
function repoById(id: string): RepoRecord | null {
  const { kind, parts } = ungid(id);
  if (kind !== 'Repository') return null;
  const wanted = Number.parseInt(parts[0], 10);
  for (const repo of forge.repos.values()) if (repo.id === wanted) return repo;
  return null;
}

function runMutation(name: string, args: string, variables: Record<string, unknown>): Node {
  const input = (argValue(args, 'input', variables) ?? {}) as Record<string, unknown>;
  if (name === 'createIssue') {
    const repo = repoById(String(input.repositoryId ?? ''));
    if (repo === null) throw new GqlError('Could not resolve to a Repository with the global id');
    const now = forge.tick();
    repo.issueSeq += 1;
    const issue: IssueRecord = {
      number: repo.issueSeq,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: Array.isArray(input.labelIds) ? [] : [],
      user: VIEWER,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.issues.push(issue);
    return { createIssue: { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) } };
  }
  if (name === 'closeIssue') {
    const { kind, parts } = ungid(String(input.issueId ?? ''));
    if (kind !== 'Issue') throw new GqlError('Could not resolve to an Issue');
    const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number.parseInt(parts[0], 10));
    const issue = repo?.issues.find((entry) => entry.number === Number.parseInt(parts[1], 10));
    if (repo === undefined || repo === null || issue === undefined) throw new GqlError('Could not resolve to an Issue');
    const now = forge.tick();
    issue.state = 'closed';
    issue.closedAt = now;
    issue.updatedAt = now;
    return { closeIssue: { __typename: 'CloseIssuePayload', issue: issueNode(repo, issue) } };
  }
  if (name === 'addComment') {
    const { kind, parts } = ungid(String(input.subjectId ?? ''));
    if (kind !== 'Issue') throw new GqlError('Could not resolve to a subject to comment on');
    const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number.parseInt(parts[0], 10));
    const issue = repo?.issues.find((entry) => entry.number === Number.parseInt(parts[1], 10));
    if (repo === undefined || repo === null || issue === undefined) throw new GqlError('Could not resolve to an Issue');
    const now = forge.tick();
    repo.commentSeq += 1;
    const comment = { id: repo.commentSeq + repo.id * 1000, issueNumber: issue.number, body: String(input.body ?? ''), user: VIEWER, createdAt: now };
    repo.comments.push(comment);
    issue.updatedAt = now;
    return {
      addComment: {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: gid('IssueComment', comment.id), body: comment.body, createdAt: iso(now), author: personOf(VIEWER) },
        },
      },
    };
  }
  if (name === 'createPullRequest') {
    const repo = repoById(String(input.repositoryId ?? ''));
    if (repo === null) throw new GqlError('Could not resolve to a Repository with the global id');
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    if (resolveCommit(repo, head) === null) throw new GqlError(`Head sha can't be blank: ${head}`);
    const now = forge.tick();
    repo.pullSeq += 1;
    const pull: PullRecord = {
      number: repo.pullSeq,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      head,
      base,
      state: 'open',
      user: VIEWER,
      createdAt: now,
      updatedAt: now,
      mergedAt: null,
      mergeSha: null,
    };
    repo.pulls.push(pull);
    return { createPullRequest: { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) } };
  }
  if (name === 'mergePullRequest') {
    const { kind, parts } = ungid(String(input.pullRequestId ?? ''));
    if (kind !== 'PullRequest') throw new GqlError('Could not resolve to a PullRequest');
    const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number.parseInt(parts[0], 10));
    const pull = repo?.pulls.find((entry) => entry.number === Number.parseInt(parts[1], 10));
    if (repo === undefined || repo === null || pull === undefined) throw new GqlError('Could not resolve to a PullRequest');
    const headOid = resolveCommit(repo, pull.head);
    const baseOid = resolveCommit(repo, pull.base);
    if (headOid === null || baseOid === null) throw new GqlError('Pull request is not mergeable');
    const headTree = treeOf(repo, headOid);
    const baseTree = treeOf(repo, baseOid);
    const files = new Map<string, string>(baseTree === null ? [] : flattenTree(repo, baseTree));
    if (headTree !== null) for (const [path, content] of flattenTree(repo, headTree)) files.set(path, content);
    const tree = buildTreeFromFiles(repo, files);
    const person = { name: scenario.viewer.name, email: scenario.viewer.email, date: forge.tick() };
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}`;
    const body = buildCommit(tree, [baseOid], person, person, message);
    const mergeSha = putObject(repo, 'commit', body);
    repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
    pull.state = 'closed';
    pull.mergedAt = forge.tick();
    pull.mergeSha = mergeSha;
    pull.updatedAt = pull.mergedAt;
    return { mergePullRequest: { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) } };
  }
  if (name === 'resolveReviewThread' || name === 'addReaction' || name === 'addLabelsToLabelable') {
    return { [name]: { __typename: 'Payload' } };
  }
  throw new GqlError(`Unknown mutation: ${name}`);
}

/** Build a tree from a flat path → content map, nesting directories. */
export function buildTreeFromFiles(repo: RepoRecord, files: ReadonlyMap<string, string>): string {
  const build = (prefix: string): string => {
    const entries: Array<{ mode: string; name: string; sha: string }> = [];
    const seenDirs = new Set<string>();
    for (const [path, content] of files) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const blob = putObject(repo, 'blob', Buffer.from(content, 'utf8'));
        entries.push({ mode: '100644', name: rest, sha: blob });
      } else {
        const dir = rest.slice(0, slash);
        if (seenDirs.has(dir)) continue;
        seenDirs.add(dir);
        const sha = build(prefix === '' ? dir : `${prefix}/${dir}`);
        entries.push({ mode: '40000', name: dir, sha });
      }
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    const parts: Buffer[] = [];
    for (const entry of entries) parts.push(Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.sha, 'hex')]));
    return putObject(repo, 'tree', Buffer.concat(parts));
  };
  return build('');
}

function runQueryField(field: Sel, variables: Record<string, unknown>): unknown {
  if (field.name === 'viewer') return personOf(VIEWER);
  if (field.name === 'repository') {
    const owner = String(argValue(field.args, 'owner', variables) ?? '');
    const name = String(argValue(field.args, 'name', variables) ?? '');
    const repo = forge.repo(owner, name);
    return repo === null ? null : repoNode(repo);
  }
  if (field.name === 'node') {
    const id = String(argValue(field.args, 'id', variables) ?? '');
    const { kind, parts } = ungid(id);
    if (kind === 'Repository') {
      const repo = repoById(id);
      return repo === null ? null : repoNode(repo);
    }
    if (kind === 'Issue') {
      const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number.parseInt(parts[0], 10));
      const issue = repo?.issues.find((entry) => entry.number === Number.parseInt(parts[1], 10));
      return repo === undefined || issue === undefined ? null : issueNode(repo, issue);
    }
    if (kind === 'PullRequest') {
      const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number.parseInt(parts[0], 10));
      const pull = repo?.pulls.find((entry) => entry.number === Number.parseInt(parts[1], 10));
      return repo === undefined || pull === undefined ? null : pullNode(repo, pull);
    }
    return null;
  }
  if (field.name === '__type') return introspection(String(argValue(field.args, 'name', variables) ?? ''));
  if (field.name === 'rateLimit') return { limit: 5000, remaining: 4999, resetAt: iso(forge.now() + 3600) };
  throw new GqlError(`Field '${field.name}' doesn't exist on type 'Query'`);
}

const MUTATION_FIELDS = ['createIssue', 'closeIssue', 'addComment', 'createPullRequest', 'mergePullRequest', 'addReaction', 'resolveReviewThread', 'addLabelsToLabelable'];

// ---------------------------------------------------------------------------------------------------
// The HTTP surface
// ---------------------------------------------------------------------------------------------------

function execute(document: Document, variables: Record<string, unknown>): Node {
  const data: Node = {};
  for (const field of document.sels) {
    if (document.op === 'mutation') {
      if (!MUTATION_FIELDS.includes(field.name)) throw new GqlError(`Field '${field.name}' doesn't exist on type 'Mutation'`);
      Object.assign(data, runMutation(field.name, field.args, variables));
    } else {
      const value = runQueryField(field, variables);
      data[field.alias] = resolveValue(value, field.sel, variables, [field.alias]);
    }
  }
  return data;
}

function answerOne(payload: unknown, variablesIn: Record<string, unknown> | undefined): Node {
  if (typeof payload !== 'object' || payload === null) return { errors: [{ message: 'the request body must be a JSON object' }] };
  const record = payload as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string') return { errors: [{ message: 'query must be a string' }] };
  const variables = record.variables === undefined || record.variables === null ? {} : (record.variables as Record<string, unknown>);
  try {
    const document = parseDocument(query);
    const data = execute(document, { ...variablesIn, ...variables });
    return { data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { data: null, errors: [{ message, type: 'INVALID_FIELD' }] };
  }
}

/** Answer one GraphQL request, or false when the path is not the GraphQL endpoint. */
export async function handleGraphql(ctx: GqlCtx): Promise<boolean> {
  const { req, res, method, segments } = ctx;
  if (segments.length !== 2 || segments[0] !== 'api' || segments[1] !== 'graphql') return false;
  if (method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  const token = (req.headers.authorization ?? '').toString().replace(/^Bearer\s+/i, '').trim();
  if (token === '') {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(await ctx.body());
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => answerOne(entry, {})));
    return true;
  }
  sendJson(res, 200, answerOne(parsed, {}));
  return true;
}