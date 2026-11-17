// The REST v3 router. Every route the suite drives lives here; the shapes live in rest-shapes.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { VIEWER, forge, scenario } from './db.ts';
import {
  buildCommit,
  commitChain,
  entryAt,
  flattenTree,
  getObject,
  parseCommit,
  putObject,
  resolveCommit,
  treeOf,
  writeTreeFromFiles,
  type Person,
  type RepoRecord,
} from './store.ts';
import {
  commitFiles,
  commitJson,
  isoTs,
  issueJson,
  labelJson,
  parseBody,
  parseTreeSafe,
  pullFiles,
  pullJson,
  readBody,
  repoJson,
  sendError,
  sendJson,
  userJson,
} from './rest-shapes.ts';

interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly body: () => Promise<string>;
}

/** The person a commit written over REST is attributed to. */
function person(): Person {
  return { name: VIEWER, email: `${VIEWER}@example.invalid`, date: forge.tick() };
}

/** The origin a request arrived on, for absolute links. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1:8080';
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  return `${proto}://${host}`;
}

/** Page a list, answering the slice and the Link header. */
function paged<T>(items: readonly T[], query: URLSearchParams, basePath: string, origin: string): { slice: T[]; link: string } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const last = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const url = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `${origin}${basePath}?${q.toString()}`;
  };
  if (page < last) links.push(`<${url(page + 1)}>; rel="next"`, `<${url(last)}>; rel="last"`);
  if (page > 1) links.push(`<${url(1)}>; rel="first"`, `<${url(page - 1)}>; rel="prev"`);
  return { slice, link: links.join(', ') };
}

/** The merge base of two commits: the nearest commit both histories hold. */
function mergeBase(repo: RepoRecord, a: string, b: string): string | null {
  const chain = (start: string): string[] => commitChain(repo, start, 400).map((c) => c.sha);
  const left = new Set(chain(a));
  for (const sha of chain(b)) if (left.has(sha)) return sha;
  return null;
}

/** Does a path differ between two blob maps? */
function changed(a: Map<string, string>, b: Map<string, string>, path: string): boolean {
  return a.get(path) !== b.get(path);
}

const TRACE = process.env.FORGE_TRACE === '1';

export async function handleRest(ctx: Ctx): Promise<boolean> {
  if (TRACE) {
    const started = process.hrtime.bigint();
    ctx.res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      process.stderr.write(`rest ${ctx.method} ${ctx.segments.join('/')} ${ms.toFixed(3)} ms\n`);
    });
  }
  const { req, res, method, segments, query } = ctx;
  if (segments.length === 0 || segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const parts = segments.slice(2).filter((p) => p !== '');

  const auth = req.headers.authorization ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1] ?? '';
  if (token === '') {
    sendError(res, 401, 'Requires authentication');
    return true;
  }

  const origin = originOf(req);

  const bodyText = async (): Promise<Record<string, unknown>> => {
    const text = await readBody(req);
    const parsed = parseBody(text);
    if (parsed === null) {
      sendError(res, 400, 'Problems parsing JSON');
      return {};
    }
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  };

  // GET /api/v3 — the API root.
  if (parts.length === 0) {
    if (method !== 'GET') { sendError(res, 405, 'Method Not Allowed'); return true; }
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: '/settings/connections/applications',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
      user_repositories_url: '/api/v3/users/{user}/repos',
      organization_repositories_url: '/api/v3/orgs/{org}/repos',
      emojis_url: '/api/v3/emojis',
    }, { 'x-oauth-scopes': 'repo, read:org, gist' });
    return true;
  }

  if (parts[0] === 'meta' && parts.length === 1) {
    sendJson(res, 200, { verifiable_password_authentication: false, installed_version: '3.0.0-forge', ssh_key_fingerprints: {} });
    return true;
  }

  if (parts[0] === 'rate_limit' && parts.length === 1) {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, used: 1, reset: Math.trunc(forge.now()) + 3600 } }, rate: { limit: 5000, remaining: 4999, used: 1, reset: Math.trunc(forge.now()) + 3600 } });
    return true;
  }

  if (parts[0] === 'user' && parts.length === 1 && method === 'GET') {
    sendJson(res, 200, { ...userJson(VIEWER), name: VIEWER, email: `${VIEWER}@example.invalid`, public_repos: forge.owned(VIEWER).length, followers: 0, following: 0, created_at: isoTs(1_700_000_000) });
    return true;
  }

  if (parts[0] === 'users' && parts.length === 2 && method === 'GET') {
    sendJson(res, 200, { ...userJson(parts[1]), type: 'User' });
    return true;
  }

  // GET/POST /api/v3/user/repos
  if (parts[0] === 'user' && parts[1] === 'repos' && parts.length === 2) {
    if (method === 'GET') {
      const mine = forge.owned(VIEWER);
      const filtered = query.get('visibility') === 'private' ? mine.filter((r) => r.private) : query.get('visibility') === 'public' ? mine.filter((r) => !r.private) : mine;
      const { slice, link } = paged(filtered, query, '/api/v3/user/repos', origin);
      const headers: Record<string, string> = {};
      if (link !== '') headers.link = link;
      sendJson(res, 200, slice.map(repoJson), headers);
      return true;
    }
    if (method === 'POST') {
      const body = await bodyText();
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') { sendError(res, 422, 'Repository creation failed: name is required'); return true; }
      if (forge.repo(VIEWER, name) !== null) { sendError(res, 422, 'Repository creation failed: name already exists on this account'); return true; }
      const repo = forge.createRepo(VIEWER, name, typeof body.description === 'string' ? body.description : '', body.private === true);
      sendJson(res, 201, repoJson(repo));
      return true;
    }
  }

  if (parts[0] !== 'repos' || parts.length < 3) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  const repo = forge.repo(parts[1], parts[2]);
  if (repo === null) { sendError(res, 404, 'Not Found'); return true; }
  const rest = parts.slice(3);

  // /repos/{owner}/{repo}
  if (rest.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
    if (method === 'PATCH') {
      const body = await bodyText();
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== '') repo.name = body.name;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      forge.repos.delete(forge.key(repo.owner, repo.name));
      sendJson(res, 204, undefined);
      return true;
    }
  }

  // /repos/{owner}/{repo}/branches
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const out = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), sha }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    sendJson(res, 200, out.map((b) => ({ name: b.name, commit: { sha: b.sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${b.sha}` }, protected: b.name === repo.defaultBranch })));
    return true;
  }

  if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
    const sha = repo.refs.get(`refs/heads/${rest[1]}`);
    if (sha === undefined) { sendError(res, 404, 'Branch not found'); return true; }
    sendJson(res, 200, { name: rest[1], commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` }, protected: rest[1] === repo.defaultBranch });
    return true;
  }

  // /repos/{owner}/{repo}/git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'GET') {
      const out = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, node_id: `REF_${ref}`, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`, object: { sha, type: getObject(repo, sha)?.type ?? 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` } }));
      sendJson(res, 200, out);
      return true;
    }
    if (rest.length === 2 && method === 'POST') {
      const body = await bodyText();
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
      if (ref === '' || sha === '') { sendError(res, 422, 'ref and sha are required'); return true; }
      if (getObject(repo, sha) === null) { sendError(res, 422, 'Object does not exist'); return true; }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: `REF_${ref}`, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`, object: { sha, type: getObject(repo, sha)?.type ?? 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` } });
      return true;
    }
  }

  // /repos/{owner}/{repo}/git/commits (POST) and /git/commits/{sha}
  if (rest[0] === 'git' && rest[1] === 'commits') {
    if (rest.length === 2 && method === 'POST') {
      const body = await bodyText();
      const tree = typeof body.tree === 'string' ? body.tree : '';
      const message = typeof body.message === 'string' ? body.message : '';
      const parents = Array.isArray(body.parents) ? body.parents.filter((p): p is string => typeof p === 'string') : [];
      if (tree === '') { sendError(res, 422, 'tree is required'); return true; }
      const p = person();
      const sha = putObject(repo, 'commit', buildCommit(tree, parents, p, p, message.endsWith('\n') ? message : `${message}\n`));
      const info = parseCommit(getObject(repo, sha)!.body);
      sendJson(res, 201, commitJson(repo, { ...info, sha }));
      return true;
    }
    if (rest.length === 3 && method === 'GET') {
      const obj = getObject(repo, rest[2]);
      if (obj === null || obj.type !== 'commit') { sendError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, commitJson(repo, { ...parseCommit(obj.body), sha: rest[2].toLowerCase() }));
      return true;
    }
  }

  // /repos/{owner}/{repo}/commits
  if (rest[0] === 'commits' && method === 'GET') {
    if (rest.length === 2) {
      const obj = getObject(repo, rest[1]);
      if (obj === null || obj.type !== 'commit') { sendError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, commitJson(repo, { ...parseCommit(obj.body), sha: rest[1].toLowerCase() }));
      return true;
    }
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = resolveCommit(repo, ref);
    if (tip === null) { sendJson(res, 200, []); return true; }
    const chain = commitChain(repo, tip, 400);
    const { slice, link } = paged(chain, query, `/api/v3/repos/${repo.owner}/${repo.name}/commits`, origin);
    const headers: Record<string, string> = {};
    if (link !== '') headers.link = link;
    sendJson(res, 200, slice.map((c) => commitJson(repo, c)), headers);
    return true;
  }

  // /repos/{owner}/{repo}/contents[/path]
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map(decodeURIComponent).join('/');
    const branch = query.get('ref') ?? repo.defaultBranch;
    const headTip = resolveCommit(repo, branch);
    const tree = headTip === null ? null : treeOf(repo, headTip);
    const entry = tree === null ? null : entryAt(repo, tree, path);
    if (method === 'GET') {
      if (tree === null) { sendError(res, 404, 'This repository is empty.'); return true; }
      if (entry === null) { sendError(res, 404, 'Not Found'); return true; }
      if (entry === 'dir') {
        const dirTree = path === '' ? tree : (() => {
          const parts = path.split('/').filter((p) => p !== '');
          let current = tree;
          for (const part of parts) {
            const node = getObject(repo, current);
            if (node === null) return tree;
            const found = node.type === 'tree' ? parseTreeSafe(node.body).find((e) => e.name === part) : undefined;
            if (found === undefined) return tree;
            current = found.sha;
          }
          return current;
        })();
        const node = getObject(repo, dirTree);
        const entries = node === null || node.type !== 'tree' ? [] : parseTreeSafe(node.body).map((e) => {
          const prefix = path === '' ? e.name : `${path}/${e.name}`;
          const isDir = e.mode === '40000';
          return {
            type: isDir ? 'dir' : 'file',
            name: e.name,
            path: prefix,
            sha: e.sha,
            size: isDir ? 0 : (getObject(repo, e.sha)?.body.length ?? 0),
            url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${prefix}`,
            html_url: `https://forge.local/${repo.owner}/${repo.name}/blob/${branch}/${prefix}`,
            download_url: isDir ? null : `https://forge.local/${repo.owner}/${repo.name}/raw/${branch}/${prefix}`,
            git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${e.sha}`,
          };
        });
        sendJson(res, 200, entries);
        return true;
      }
      const blob = getObject(repo, entry);
      if (blob === null) { sendError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.body.length,
        name: path.split('/').pop() ?? path,
        path,
        content: blob.body.toString('base64').replace(/(.{60})/g, '$1\n'),
        sha: entry,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://forge.local/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
        git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry}`,
        download_url: `https://forge.local/${repo.owner}/${repo.name}/raw/${branch}/${path}`,
      });
      return true;
    }
    if (method === 'PUT') {
      const body = await bodyText();
      const content = typeof body.content === 'string' ? Buffer.from(body.content.replace(/\n/g, ''), 'base64') : Buffer.alloc(0);
      const message = typeof body.message === 'string' && body.message !== '' ? body.message : 'Update file';
      const branchName = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const tip = resolveCommit(repo, branchName);
      const tipTree = tip === null ? null : treeOf(repo, tip);
      const files = tipTree === null ? new Map<string, string>() : flattenTree(repo, tipTree);
      const currentSha = path === '' || tipTree === null ? null : entryAt(repo, tipTree, path);
      const givenSha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
      if (givenSha !== '' && currentSha !== 'dir' && currentSha !== null && currentSha !== givenSha) {
        sendError(res, 409, 'sha does not match the current file');
        return true;
      }
      if (givenSha !== '' && currentSha === null) {
        sendError(res, 409, 'sha does not match the current file');
        return true;
      }
      const blobSha = putObject(repo, 'blob', content);
      files.set(path, blobSha);
      const commitSha = commitFiles(repo, branchName, files, message);
      const commitObj = getObject(repo, commitSha);
      const info = commitObj === null ? null : parseCommit(commitObj.body);
      sendJson(res, 201, {
        content: { type: 'file', encoding: 'base64', size: content.length, name: path.split('/').pop() ?? path, path, content: content.toString('base64'), sha: blobSha, url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`, html_url: `https://forge.local/${repo.owner}/${repo.name}/blob/${branchName}/${path}`, git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobSha}`, download_url: `https://forge.local/${repo.owner}/${repo.name}/raw/${branchName}/${path}` },
        commit: info === null ? { sha: commitSha } : { sha: commitSha, node_id: `C_${commitSha}`, message: info.message, author: { name: info.author.name, email: info.author.email, date: isoTs(info.author.date) }, committer: { name: info.committer.name, email: info.committer.email, date: isoTs(info.committer.date) }, tree: { sha: info.tree }, parents: info.parents.map((p) => ({ sha: p })), html_url: `https://forge.local/${repo.owner}/${repo.name}/commit/${commitSha}` },
      });
      return true;
    }
    if (method === 'DELETE') {
      const body = await bodyText();
      const branchName = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const tip = resolveCommit(repo, branchName);
      const tipTree = tip === null ? null : treeOf(repo, tip);
      if (tipTree === null || entry === null) { sendError(res, 404, 'Not Found'); return true; }
      const files = flattenTree(repo, tipTree);
      files.delete(path);
      const commitSha = commitFiles(repo, branchName, files, typeof body.message === 'string' ? body.message : `Delete ${path}`);
      const commitObj = getObject(repo, commitSha);
      const info = commitObj === null ? null : parseCommit(commitObj.body);
      sendJson(res, 200, { content: null, commit: info === null ? { sha: commitSha } : { sha: commitSha, message: info.message, author: { name: info.author.name, email: info.author.email, date: isoTs(info.author.date) }, committer: { name: info.committer.name, email: info.committer.email, date: isoTs(info.committer.date) }, tree: { sha: info.tree }, parents: info.parents.map((p) => ({ sha: p })) } });
      return true;
    }
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }

  // /repos/{owner}/{repo}/labels
  if (rest[0] === 'labels') {
    if (method === 'GET') { sendJson(res, 200, repo.labels.map((name, i) => labelJson(name, i))); return true; }
    if (method === 'POST') {
      const body = await bodyText();
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') { sendError(res, 422, 'name is required'); return true; }
      if (!repo.labels.includes(name)) repo.labels.push(name);
      sendJson(res, 201, labelJson(name, repo.labels.indexOf(name)));
      return true;
    }
  }

  // /repos/{owner}/{repo}/issues
  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? (sort === 'created' ? 'desc' : 'desc');
      let list = repo.issues.filter((i) => state === 'all' || i.state === state);
      list = [...list].sort((a, b) => {
        const key = sort === 'updated' ? (i: typeof a) => i.updatedAt : (i: typeof a) => i.createdAt;
        return direction === 'asc' ? key(a) - key(b) : key(b) - key(a);
      });
      const { slice, link } = paged(list, query, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, origin);
      const headers: Record<string, string> = {};
      if (link !== '') headers.link = link;
      sendJson(res, 200, slice.map((i) => issueJson(repo, i)), headers);
      return true;
    }
    if (rest.length === 1 && method === 'POST') {
      const body = await bodyText();
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') { sendError(res, 422, 'title is required'); return true; }
      const wanted = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      const unknown = wanted.filter((l) => !repo.labels.includes(l));
      if (unknown.length > 0) { sendError(res, 422, `Label does not exist: ${unknown.join(', ')}`); return true; }
      repo.issueSeq += 1;
      const now = forge.tick();
      const issue = { number: repo.issueSeq, title, body: typeof body.body === 'string' ? body.body : '', state: 'open' as const, labels: wanted, user: VIEWER, createdAt: now, updatedAt: now, closedAt: null };
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(repo, issue));
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const issue = repo.issues.find((i) => i.number === Number(rest[1]));
      if (issue === undefined) { sendError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (rest.length === 2 && method === 'PATCH') {
      const issue = repo.issues.find((i) => i.number === Number(rest[1]));
      if (issue === undefined) { sendError(res, 404, 'Not Found'); return true; }
      const body = await bodyText();
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'closed' && issue.state !== 'closed') { issue.state = 'closed'; issue.closedAt = forge.tick(); }
      else if (body.state === 'open' && issue.state !== 'open') { issue.state = 'open'; issue.closedAt = null; }
      if (Array.isArray(body.labels)) {
        const wanted = body.labels.filter((l): l is string => typeof l === 'string');
        const unknown = wanted.filter((l) => !repo.labels.includes(l));
        if (unknown.length > 0) { sendError(res, 422, `Label does not exist: ${unknown.join(', ')}`); return true; }
        issue.labels = wanted;
      }
      issue.updatedAt = forge.tick();
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      const issue = repo.issues.find((i) => i.number === Number(rest[1]));
      if (issue === undefined) { sendError(res, 404, 'Not Found'); return true; }
      if (method === 'GET') {
        const list = repo.comments.filter((c) => c.issueNumber === issue.number).sort((a, b) => a.id - b.id);
        sendJson(res, 200, list.map((c) => ({ id: c.id, node_id: `C_${c.id}`, body: c.body, user: userJson(c.user), created_at: isoTs(c.createdAt), updated_at: isoTs(c.createdAt), url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}` })));
        return true;
      }
      if (method === 'POST') {
        const body = await bodyText();
        const text = typeof body.body === 'string' ? body.body : '';
        if (text === '') { sendError(res, 422, 'body is required'); return true; }
        repo.commentSeq += 1;
        const comment = { id: repo.commentSeq, issueNumber: issue.number, body: text, user: VIEWER, createdAt: forge.tick() };
        repo.comments.push(comment);
        issue.updatedAt = comment.createdAt;
        sendJson(res, 201, { id: comment.id, node_id: `C_${comment.id}`, body: comment.body, user: userJson(comment.user), created_at: isoTs(comment.createdAt), updated_at: isoTs(comment.createdAt), url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}` });
        return true;
      }
    }
  }

  // /repos/{owner}/{repo}/pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state).sort((a, b) => b.number - a.number);
      const { slice, link } = paged(list, query, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, origin);
      const headers: Record<string, string> = {};
      if (link !== '') headers.link = link;
      sendJson(res, 200, slice.map((p) => pullJson(repo, p)), headers);
      return true;
    }
    if (rest.length === 1 && method === 'POST') {
      const body = await bodyText();
      const title = typeof body.title === 'string' ? body.title : '';
      const headRaw = typeof body.head === 'string' ? body.head : '';
      const baseRaw = typeof body.base === 'string' ? body.base : '';
      if (title === '' || headRaw === '' || baseRaw === '') { sendError(res, 422, 'title, head and base are required'); return true; }
      const head = headRaw;
      const base = baseRaw;
      if (sideSha(repo, head) === null || sideSha(repo, base) === null) { sendError(res, 422, 'No commits between the base and the head'); return true; }
      repo.pullSeq += 1;
      const now = forge.tick();
      const pull = { number: repo.pullSeq, title, body: typeof body.body === 'string' ? body.body : '', head, base, state: 'open' as const, user: VIEWER, createdAt: now, updatedAt: now, mergedAt: null, mergeSha: null };
      repo.pulls.push(pull);
      sendJson(res, 201, pullJson(repo, pull));
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const pull = repo.pulls.find((p) => p.number === Number(rest[1]));
      if (pull === undefined) { sendError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, pullJson(repo, pull));
      return true;
    }
    if (rest.length === 2 && method === 'PATCH') {
      const pull = repo.pulls.find((p) => p.number === Number(rest[1]));
      if (pull === undefined) { sendError(res, 404, 'Not Found'); return true; }
      const body = await bodyText();
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed') pull.state = 'closed';
      if (body.state === 'open') pull.state = 'open';
      pull.updatedAt = forge.tick();
      sendJson(res, 200, pullJson(repo, pull));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const pull = repo.pulls.find((p) => p.number === Number(rest[1]));
      if (pull === undefined) { sendError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, pullFiles(repo, pull));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      const pull = repo.pulls.find((p) => p.number === Number(rest[1]));
      if (pull === undefined) { sendError(res, 404, 'Not Found'); return true; }
      if (method === 'GET') { sendJson(res, 204, undefined); return true; }
      if (method === 'PUT' || method === 'POST') {
        const body = await bodyText();
        const method_ = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
        const result = mergePull(repo, pull, method_);
        if (result === null) { sendError(res, 405, 'Pull Request is not mergeable'); return true; }
        sendJson(res, 200, { sha: result, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
    }
  }

  sendError(res, 404, 'Not Found');
  return true;
}

function sideSha(repo: RepoRecord, raw: string): string | null {
  const ref = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
  return resolveCommit(repo, ref);
}

/** Merge a pull request: squash takes the head tree onto the base tip, merge makes a merge commit. */
function mergePull(repo: RepoRecord, pull: { head: string; base: string; number: number; state: string; mergedAt: number | null; mergeSha: string | null; updatedAt: number }, method: string): string | null {
  const headSha = sideSha(repo, pull.head);
  const baseSha = sideSha(repo, pull.base);
  if (headSha === null || baseSha === null) return null;
  const baseTree = treeOf(repo, baseSha);
  const headTree = treeOf(repo, headSha);
  if (baseTree === null || headTree === null) return null;
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const fork = mergeBase(repo, baseSha, headSha);
  const forkFiles = fork === null ? new Map<string, string>() : (() => {
    const t = treeOf(repo, fork);
    return t === null ? new Map<string, string>() : flattenTree(repo, t);
  })();
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  let conflict = false;
  for (const path of paths) {
    const baseChanged = changed(forkFiles, baseFiles, path);
    const headChanged = changed(forkFiles, headFiles, path);
    if (baseChanged && headChanged && baseFiles.get(path) !== headFiles.get(path)) conflict = true;
  }
  if (conflict) return null;
  const result = new Map<string, string>(baseFiles);
  for (const path of paths) {
    if (changed(forkFiles, headFiles, path)) {
      const blob = headFiles.get(path);
      if (blob === undefined) result.delete(path);
      else result.set(path, blob);
    }
  }
  const tree = writeTreeFromFiles(repo, result);
  const p = person();
  const parents = method === 'merge' ? [baseSha, headSha] : [baseSha];
  const message = method === 'squash' ? `Squash merge pull request #${pull.number}` : `Merge pull request #${pull.number}`;
  const sha = putObject(repo, 'commit', buildCommit(tree, parents, p, p, `${message}\n`));
  const branch = pull.base.includes(':') ? pull.base.slice(pull.base.indexOf(':') + 1) : pull.base;
  repo.refs.set(`refs/heads/${branch}`, sha);
  pull.state = 'closed';
  pull.mergedAt = forge.tick();
  pull.mergeSha = sha;
  pull.updatedAt = pull.mergedAt;
  return sha;
}

/** Export the router's context type for the app. */
export type { Ctx };