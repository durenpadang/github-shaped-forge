// The REST v3 surface: repositories, contents, branches, commits, issues, comments and pull requests,
// under /api/v3, answering the shapes gh and github-mcp-server read. Every reply is JSON and carries
// X-GitHub-Request-Id; errors carry a JSON body with a string message.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { VIEWER, forge } from './db.ts';
import {
  buildCommit,
  buildTree,
  commitChain,
  entryAt,
  flattenTree,
  getObject,
  parseCommit,
  parseTree,
  putObject,
  resolveCommit,
  treeOf,
  writeTreeFromFiles,
  type CommitInfo,
  type IssueRecord,
  type Person,
  type PullRecord,
  type RepoRecord,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
let requestSeq = 0;

/** Parse a request body, answering null when it is not JSON. */
export function parseBody(text: string): unknown {
  try {
    return JSON.parse(text.trim() === '' ? '{}' : text);
  } catch {
    return null;
  }
}

/** A tree body's entries, tolerating a body that is not a tree at all. */
export function parseTreeSafe(body: Buffer): TreeEntry[] {
  return parseTree(body);
}

/** Answer with JSON and the request-id header every reply carries. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  requestSeq += 1;
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  const base: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': `MF-${requestSeq}-${Math.trunc(forge.now())}`,
  };
  res.writeHead(status, { ...base, ...headers, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** An error reply: GitHub's body shape, message first. */
export function sendError(res: ServerResponse, status: number, message: string, headers: Readonly<Record<string, string>> = {}): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' }, headers);
}

/** Read a request body as text, at most `limit` bytes. */
export async function readBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse a JSON body; throws a 400-worthy error when it is not JSON. */
export function parseJson(text: string): unknown {
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

/** A repository as the REST surface writes it. */
export function repoJson(repo: RepoRecord): Record<string, unknown> {
  const t = isoTs(repo.createdAt);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    html_url: `https://forge.local/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    default_branch: repo.defaultBranch,
    created_at: t,
    updated_at: t,
    pushed_at: t,
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, push: true, pull: true },
  };
}

/** A login as the REST surface writes it. */
export function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: 1000 + (login === VIEWER ? 0 : 1),
    node_id: `U_${login}`,
    type: 'User',
    site_admin: false,
    url: `/api/v3/users/${login}`,
    html_url: `https://forge.local/${login}`,
  };
}

/** Seconds since the epoch as GitHub's ISO timestamp. */
export function isoTs(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function labelJson(name: string, index: number): Record<string, unknown> {
  return { id: 2000 + index, node_id: `L_${name}`, name, color: 'ededed', description: null, default: index < 3 };
}

/** An issue as the REST surface writes it. */
export function issueJson(repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  return {
    id: 300000 + issue.number,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(issue.user),
    labels: issue.labels.map((name, i) => labelJson(name, repo.labels.indexOf(name) >= 0 ? repo.labels.indexOf(name) : i)),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: repo.comments.filter((c) => c.issueNumber === issue.number).length,
    created_at: isoTs(issue.createdAt),
    updated_at: isoTs(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : isoTs(issue.closedAt),
    html_url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function commentJson(repo: RepoRecord, comment: { id: number; issueNumber: number; body: string; user: string; createdAt: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: isoTs(comment.createdAt),
    updated_at: isoTs(comment.createdAt),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://forge.local/${repo.owner}/${repo.name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
  };
}

/** The commit a pull request's side names, and the ref it came from. */
function sideOf(repo: RepoRecord, raw: string): { ref: string; sha: string | null } {
  const ref = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
  return { ref, sha: resolveCommit(repo, ref) };
}

/** A pull request as the REST surface writes it. */
export function pullJson(repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  const headSha = sideOf(repo, pull.head).sha;
  const baseSha = sideOf(repo, pull.base).sha;
  return {
    id: 400000 + pull.number,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(pull.user),
    head: { ref: pull.head.includes(':') ? pull.head.slice(pull.head.indexOf(':') + 1) : pull.head, sha: headSha, label: `${pull.user}:${pull.head}`, repo: repoJson(repo) },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}`, repo: repoJson(repo) },
    merged: pull.mergedAt !== null,
    merged_at: pull.mergedAt === null ? null : isoTs(pull.mergedAt),
    merge_commit_sha: pull.mergeSha,
    mergeable: true,
    merged_by: pull.mergedAt === null ? null : userJson(pull.user),
    comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: isoTs(pull.createdAt),
    updated_at: isoTs(pull.updatedAt),
    closed_at: pull.state === 'closed' && pull.mergedAt === null ? isoTs(pull.updatedAt) : null,
    html_url: `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** The head and base blob maps of a pull request, or null when a side is missing. */
function pullTrees(repo: RepoRecord, pull: PullRecord): { base: Map<string, string>; head: Map<string, string> } | null {
  const headSha = sideOf(repo, pull.head).sha;
  const baseSha = sideOf(repo, pull.base).sha;
  if (headSha === null || baseSha === null) return null;
  const headTree = treeOf(repo, headSha);
  const baseTree = treeOf(repo, baseSha);
  if (headTree === null || baseTree === null) return null;
  return { base: flattenTree(repo, baseTree), head: flattenTree(repo, headTree) };
}

/** Count the lines a blob adds and deletes against another, by a line diff of the two texts. */
function lineCounts(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
  const a = before === null ? [] : before.toString('utf8').split('\n');
  const b = after === null ? [] : after.toString('utf8').split('\n');
  if (before === null) return { additions: b.length === 0 ? 0 : b.length - (b[b.length - 1] === '' ? 1 : 0), deletions: 0 };
  if (after === null) return { additions: 0, deletions: a.length === 0 ? 0 : a.length - (a[a.length - 1] === '' ? 1 : 0) };
  // A longest-common-subsequence length over the two line arrays.
  const n = a.length;
  const m = b.length;
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  const common = prev[m];
  return { additions: Math.max(0, m - common), deletions: Math.max(0, n - common) };
}

/** One blob's text at a path in a blob map, or null. */
function blobAt(repo: RepoRecord, files: Map<string, string>, path: string): Buffer | null {
  const id = files.get(path);
  if (id === undefined) return null;
  const obj = getObject(repo, id);
  return obj === null ? null : obj.body;
}

/** The files a pull request changes, with the counts GitHub reports. */
export function pullFiles(repo: RepoRecord, pull: PullRecord): Record<string, unknown>[] {
  const trees = pullTrees(repo, pull);
  if (trees === null) return [];
  const paths = new Set<string>([...trees.base.keys(), ...trees.head.keys()]);
  const out: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const before = blobAt(repo, trees.base, path);
    const after = blobAt(repo, trees.head, path);
    if (before !== null && after !== null && before.equals(after)) continue;
    const status = before === null ? 'added' : after === null ? 'removed' : 'modified';
    const counts = lineCounts(before, after);
    let patch = '';
    if (before !== null) for (const line of before.toString('utf8').split('\n')) patch += `-${line}\n`;
    if (after !== null) for (const line of after.toString('utf8').split('\n')) patch += `+${line}\n`;
    out.push({
      sha: after !== null ? filesha(repo, trees.head, path) : filesha(repo, trees.base, path),
      filename: path,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      blob_url: `https://forge.local/${repo.owner}/${repo.name}/blob/${pull.base}/${path}`,
      raw_url: `https://forge.local/${repo.owner}/${repo.name}/raw/${pull.base}/${path}`,
      contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      patch,
    });
  }
  return out;
}

function filesha(repo: RepoRecord, files: Map<string, string>, path: string): string {
  return files.get(path) ?? '';
}

/** Commit one tree change on a branch, answering the new commit's id. */
export function commitFiles(repo: RepoRecord, branch: string, files: Map<string, string>, message: string, date = forge.tick()): string {
  const tip = resolveCommit(repo, branch);
  const tree = writeTreeFromFiles(repo, files);
  const person: Person = { name: VIEWER, email: `${VIEWER}@example.invalid`, date };
  const body = buildCommit(tree, tip === null ? [] : [tip], person, person, message);
  const sha = putObject(repo, 'commit', body);
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.pushedAt = date;
  return sha;
}

/** The commit message of one commit, first line. */
export function commitMessage(repo: RepoRecord, sha: string): string {
  const obj = getObject(repo, sha);
  if (obj === null) return '';
  return parseCommit(obj.body).message.split('\n')[0];
}

/** A branch as the REST surface writes it. */
function branchJson(repo: RepoRecord, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: name === repo.defaultBranch,
    protection: { enabled: false },
  };
}

/** A commit as the REST surface writes it. */
export function commitJson(repo: RepoRecord, info: CommitInfo): Record<string, unknown> {
  return {
    sha: info.sha,
    node_id: `C_${info.sha}`,
    commit: {
      message: info.message,
      author: { name: info.author.name, email: info.author.email, date: isoTs(info.author.date) },
      committer: { name: info.committer.name, email: info.committer.email, date: isoTs(info.committer.date) },
      tree: { sha: info.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${info.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${info.sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${info.sha}`,
    html_url: `https://forge.local/${repo.owner}/${repo.name}/commit/${info.sha}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${info.sha}/comments`,
    author: userJson(info.author.name || VIEWER),
    committer: userJson(info.committer.name || VIEWER),
    parents: info.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}` })),
  };
}