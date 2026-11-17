// The forge's store: git objects and refs per repository, plus the REST entities (issues, pulls,
// comments) that hang off them. Everything lives in memory for the process's life; the suite finishes
// inside one process, so a store in memory is the whole database.

import { createHash } from 'node:crypto';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly body: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly sha: string;
}

export interface Person {
  readonly name: string;
  readonly email: string;
  readonly date: number;
}

export interface CommitInfo {
  readonly sha: string;
  readonly tree: string;
  readonly parents: string[];
  readonly author: Person;
  readonly committer: Person;
  readonly message: string;
}

export interface IssueRecord {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface CommentRecord {
  id: number;
  issueNumber: number;
  body: string;
  user: string;
  createdAt: number;
}

export interface PullRecord {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  user: string;
  createdAt: number;
  updatedAt: number;
  mergedAt: number | null;
  mergeSha: string | null;
}

export interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: number;
  pushedAt: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issueSeq: number;
  commentSeq: number;
  pullSeq: number;
  issues: IssueRecord[];
  comments: CommentRecord[];
  pulls: PullRecord[];
  labels: string[];
}

/** sha1 of a buffer, hex. */
export function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/** The object with its git header ("blob <n>\0"), as git hashes it. */
function objectPayload(type: ObjType, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${body.length}\0`, 'utf8'), body]);
}

/** Store one object and answer its id. */
export function putObject(repo: RepoRecord, type: ObjType, body: Buffer): string {
  const id = sha1Hex(objectPayload(type, body));
  if (!repo.objects.has(id)) repo.objects.set(id, { type, body });
  return id;
}

/** An object by id, or null. */
export function getObject(repo: RepoRecord, id: string): GitObject | null {
  return repo.objects.get(id.toLowerCase()) ?? null;
}

/** Parse a tree body into entries. */
export function parseTree(body: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < body.length) {
    const space = body.indexOf(0x20, i);
    if (space < 0) break;
    const nul = body.indexOf(0, space);
    if (nul < 0) break;
    const mode = body.subarray(i, space).toString('latin1');
    const name = body.subarray(space + 1, nul).toString('utf8');
    const sha = body.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}

/** Build a tree body from entries, in git's order (names sorted, a directory sorts as "name/"). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit body into its fields. */
export function parseCommit(body: Buffer): CommitInfo {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author: Person = { name: '', email: '', date: 0 };
  let committer: Person = { name: '', email: '', date: 0 };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = parsePerson(line.slice(7));
    else if (line.startsWith('committer ')) committer = parsePerson(line.slice(10));
  }
  return { sha: '', tree, parents, author, committer, message };
}

function parsePerson(text: string): Person {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(text.trim());
  if (m === null) return { name: text.trim(), email: '', date: 0 };
  return { name: m[1], email: m[2], date: Number(m[3]) };
}

/** A person line as git writes it. */
export function formatPerson(p: Person): string {
  const tz = '+0000';
  return `${p.name} <${p.email}> ${Math.trunc(p.date)} ${tz}`;
}

/** Build a commit body. */
export function buildCommit(tree: string, parents: readonly string[], author: Person, committer: Person, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${formatPerson(author)}`);
  lines.push(`committer ${formatPerson(committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

/** The commit a ref points at, walking through tag objects. */
export function resolveCommit(repo: RepoRecord, rev: string): string | null {
  let id: string | null = null;
  if (/^[0-9a-f]{40}$/i.test(rev)) id = rev.toLowerCase();
  else {
    const direct = repo.refs.get(`refs/heads/${rev}`) ?? repo.refs.get(`refs/tags/${rev}`) ?? repo.refs.get(rev);
    if (direct !== undefined) id = direct;
  }
  if (id === null) return null;
  for (let hop = 0; hop < 8; hop += 1) {
    const obj = getObject(repo, id);
    if (obj === null) return null;
    if (obj.type === 'commit') return id;
    if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/.exec(obj.body.toString('utf8'));
      if (m === null) return null;
      id = m[1];
      continue;
    }
    return null;
  }
  return null;
}

/** The tree id of a commit-ish, or null. */
export function treeOf(repo: RepoRecord, rev: string): string | null {
  const commit = resolveCommit(repo, rev);
  if (commit === null) return null;
  const obj = getObject(repo, commit);
  if (obj === null) return null;
  return parseCommit(obj.body).tree;
}

/** Flat map of path -> blob id for a tree, recursively. */
export function flattenTree(repo: RepoRecord, treeId: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const obj = getObject(repo, treeId);
  if (obj === null || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.body)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [k, v] of flattenTree(repo, entry.sha, path)) out.set(k, v);
    } else if (entry.mode === '160000') continue;
    else out.set(path, entry.sha);
  }
  return out;
}

/** The entry at one path: a blob id, 'dir', or null. */
export function entryAt(repo: RepoRecord, treeId: string, path: string): string | 'dir' | null {
  const parts = path.split('/').filter((p) => p !== '');
  let current = treeId;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = getObject(repo, current);
    if (obj === null || obj.type !== 'tree') return null;
    const entry = parseTree(obj.body).find((e) => e.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return entry.mode === '40000' ? 'dir' : entry.sha;
    if (entry.mode !== '40000') return null;
    current = entry.sha;
  }
  return null;
}

/** Write a nested tree for the given files (path -> blob id), answering the root tree id. */
export function writeTreeFromFiles(repo: RepoRecord, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, blob] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], blob);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, blob] of node.files) entries.push({ mode: '100644', name, sha: blob });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: write(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return write(root);
}

/** A repository with every field the REST surface needs. */
export function makeRepo(id: number, owner: string, name: string, description: string, isPrivate: boolean, now: number): RepoRecord {
  return {
    id,
    owner,
    name,
    description,
    private: isPrivate,
    defaultBranch: 'main',
    createdAt: now,
    pushedAt: now,
    objects: new Map(),
    refs: new Map(),
    issueSeq: 0,
    commentSeq: 0,
    pullSeq: 0,
    issues: [],
    comments: [],
    pulls: [],
    labels: [],
  };
}

/** A commit's first-parent chain, newest first, at most `limit`. */
export function commitChain(repo: RepoRecord, start: string, limit = 100): CommitInfo[] {
  const out: CommitInfo[] = [];
  let id: string | null = start;
  while (id !== null && out.length < limit) {
    const obj = getObject(repo, id);
    if (obj === null || obj.type !== 'commit') break;
    const info = parseCommit(obj.body);
    out.push({ ...info, sha: id });
    id = info.parents.length > 0 ? info.parents[0] : null;
  }
  return out;
}