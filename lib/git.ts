// Git's smart HTTP: pkt-line framing, the v2 upload-pack exchange (ls-refs and fetch), the v0
// receive-pack exchange with report-status, and a packfile reader/writer that resolves OFS_DELTA and
// REF_DELTA. No git binary, no shell: the objects live in the store and the wire is bytes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { forge } from './db.ts';
import { getObject, parseTree, putObject, type RepoRecord, type TreeEntry } from './store.ts';

export interface GitCtx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
const AGENT = 'forge/0.1';
const ZERO = '0'.repeat(40);

/** One pkt-line: a four-hex-digit length, then the payload. */
function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

/** A pkt-line carrying one side-band packet: band byte, then its slice of data. */
function sideband(band: number, data: Buffer): Buffer {
  return pkt(Buffer.concat([Buffer.from([band]), data]));
}

interface Packet {
  readonly kind: 'data' | 'flush' | 'delim';
  readonly payload: Buffer;
}

/** Decode a whole pkt-line stream. */
function decodePktLines(input: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= input.length) {
    const header = input.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    offset += 4;
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      continue;
    }
    if (length < 4) break;
    const end = offset + length - 4;
    packets.push({ kind: 'data', payload: input.subarray(offset, Math.min(end, input.length)) });
    offset = end;
  }
  return packets;
}

function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function objectId(type: string, body: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${body.length}\0`, 'utf8'), body]));
}

// ---------------------------------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------------------------------

const TYPE_NAMES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

interface PackedObject {
  readonly type: string;
  readonly body: Buffer;
  readonly oid: string;
}

/** Apply a git delta to a base object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    let byte = delta[offset++];
    value = byte & 0x7f;
    while (byte & 0x80) {
      byte = delta[offset++];
      value |= (byte & 0x7f) << shift + 7;
      shift += 7;
    }
    return value;
  };
  void readSize(); // the base size, implied by the base we were handed
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset |= delta[offset++];
      if (op & 0x02) copyOffset |= delta[offset++] << 8;
      if (op & 0x04) copyOffset |= delta[offset++] << 16;
      if (op & 0x08) copyOffset |= delta[offset++] << 24;
      if (op & 0x10) copySize |= delta[offset++];
      if (op & 0x20) copySize |= delta[offset++] << 8;
      if (op & 0x40) copySize |= delta[offset++] << 16;
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      break;
    }
  }
  return out;
}

/** Read a packfile, resolving OFS_DELTA and REF_DELTA against objects in the pack or in the store. */
function readPack(repo: RepoRecord, pack: Buffer): Map<string, PackedObject> {
  const objects = new Map<string, PackedObject>();
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') return objects;
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const byOffset = new Map<number, PackedObject>();
  const pending: Array<{ type: number; body: Buffer; offset: number; base: number | string }> = [];

  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset++];
    const type = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let base: number | string = -1;
    if (type === 6) {
      let byte2 = pack[offset++];
      let value = byte2 & 0x7f;
      while (byte2 & 0x80) {
        byte2 = pack[offset++];
        value = ((value + 1) << 7) | (byte2 & 0x7f);
      }
      base = start - value;
    } else if (type === 7) {
      base = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // Inflate this entry: zlib knows where it ends, so try growing slices.
    let body: Buffer | null = null;
    let consumed = 0;
    let slice = Math.max(size + 64, 256);
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const end = Math.min(pack.length, offset + slice);
      try {
        body = inflateSync(pack.subarray(offset, end));
        const inflated = inflateSync(pack.subarray(offset, end));
        consumed = 0;
        // Find how many input bytes the stream used by re-inflating with a tracked window.
        consumed = zlibConsumed(pack.subarray(offset, end), inflated.length);
        body = inflated;
        break;
      } catch {
        slice *= 2;
      }
    }
    if (body === null) {
      body = inflateSync(pack.subarray(offset));
      consumed = pack.length - 4 - offset;
    }
    offset += consumed;
    const entry = { type, body, offset: start, base };
    pending.push(entry);
    byOffset.set(start, { type: TYPE_NAMES[type] ?? 'blob', body, oid: '' });
  }

  // Resolve deltas, repeatedly, since a delta's base may itself be a delta.
  const resolved = new Map<number, PackedObject>();
  const unresolved = [...pending];
  for (const entry of pending) {
    if (entry.type === 1 || entry.type === 2 || entry.type === 3 || entry.type === 4) {
      const type = TYPE_NAMES[entry.type];
      const oid = objectId(type, entry.body);
      const object = { type, body: entry.body, oid };
      resolved.set(entry.offset, object);
      objects.set(oid, object);
    }
  }
  let progress = true;
  while (unresolved.length > 0 && progress) {
    progress = false;
    for (let index = unresolved.length - 1; index >= 0; index -= 1) {
      const entry = unresolved[index];
      if (entry.type !== 6 && entry.type !== 7) {
        unresolved.splice(index, 1);
        continue;
      }
      let baseObject: PackedObject | undefined;
      if (typeof entry.base === 'number') baseObject = resolved.get(entry.base);
      else baseObject = objects.get(entry.base) ?? getObject(repo, entry.base);
      if (baseObject == null) continue;
      const body = applyDelta(baseObject.body, entry.body);
      const object = { type: baseObject.type, body, oid: objectId(baseObject.type, body) };
      resolved.set(entry.offset, object);
      objects.set(object.oid, object);
      unresolved.splice(index, 1);
      progress = true;
    }
  }
  return objects;
}

/** How many input bytes a zlib stream used, by inflating with a bounded window. */
function zlibConsumed(input: Buffer, expected: number): number {
  let low = 2;
  let high = input.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    let ok = false;
    try {
      const out = inflateSync(input.subarray(0, mid));
      ok = out.length === expected;
    } catch {
      ok = false;
    }
    if (ok) high = mid;
    else low = mid + 1;
  }
  return low;
}

/** Build a packfile from plain objects, no deltas. */
function writePack(objects: readonly PackedObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const type = TYPE_CODES[object.type] ?? 3;
    const size = object.body.length;
    const bytes: number[] = [];
    let byte = (type << 4) | (size & 0x0f);
    let remaining = size >>> 4;
    while (remaining > 0) {
      bytes.push(byte | 0x80);
      byte = remaining & 0x7f;
      remaining >>>= 7;
    }
    bytes.push(byte);
    parts.push(Buffer.from(bytes), deflateSync(object.body));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------------------------------

/** Every object reachable from the given tips, commits first then their trees and blobs. */
function reachable(repo: RepoRecord, tips: readonly string[], stopAt: ReadonlySet<string> = new Set()): PackedObject[] {
  const out: PackedObject[] = [];
  const seen = new Set<string>();
  const walkCommit = (oid: string): void => {
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current) || stopAt.has(current)) continue;
      seen.add(current);
      const object = getObject(repo, current);
      if (object == null) continue;
      out.push({ type: object.type, body: object.body, oid: current });
      if (object.type === 'commit') {
        const text = object.body.toString('utf8');
        const tree = /^tree ([0-9a-f]{40})/m.exec(text);
        if (tree !== null) walkTree(tree[1]);
        for (const match of text.matchAll(/^parent ([0-9a-f]{40})/gm)) stack.push(match[1]);
      } else if (object.type === 'tag') {
        const target = /^object ([0-9a-f]{40})/m.exec(object.body.toString('utf8'));
        if (target !== null) stack.push(target[1]);
      }
    }
  };
  const walkTree = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const object = getObject(repo, oid);
    if (object == null) return;
    out.push({ type: object.type, body: object.body, oid });
    for (const entry of parseTree(object.body)) {
      if (entry.mode === '40000' || entry.mode === '040000') walkTree(entry.sha);
      else {
        if (seen.has(entry.sha)) continue;
        seen.add(entry.sha);
        const blob = getObject(repo, entry.sha);
        if (blob != null) out.push({ type: blob.type, body: blob.body, oid: entry.sha });
      }
    }
  };
  for (const tip of tips) walkCommit(tip);
  return out;
}

/** The commits reachable from a tip, newest first, bounded by depth (0 = unlimited). */
function commitChain(repo: RepoRecord, tip: string, depth = 0): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let frontier = [tip];
  let level = 0;
  while (frontier.length > 0 && (depth === 0 || level < depth)) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      out.push(oid);
      const object = getObject(repo, oid);
      if (object == null || object.type !== 'commit') continue;
      for (const match of object.body.toString('utf8').matchAll(/^parent ([0-9a-f]{40})/gm)) next.push(match[1]);
    }
    frontier = next;
    level += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Repository lookup and refs
// ---------------------------------------------------------------------------------------------------

/** The repository a git path names, or null when it does not exist. */
function repoFor(owner: string, name: string): RepoRecord | null {
  return forge.repo(owner, name) ?? null;
}

/** A ref's object id, following HEAD. */
function refOid(repo: RepoRecord, ref: string): string | null {
  if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  return repo.refs.get(ref) ?? null;
}

/** Every ref a client may see, HEAD first. */
function refList(repo: RepoRecord): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  const head = refOid(repo, 'HEAD');
  if (head !== null) out.push({ name: 'HEAD', oid: head });
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  return out;
}

function gitHeaders(res: ServerResponse, service: string, body: Buffer): void {
  res.writeHead(200, {
    'content-type': `application/x-${service}-result`,
    'content-length': String(body.length),
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function advertisementHeaders(res: ServerResponse, service: string): void {
  res.writeHead(200, {
    'content-type': `application/x-${service}-advertisement`,
    'cache-control': 'no-cache',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
    pragma: 'no-cache',
  });
}

/** The v2 capability advertisement. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

const RECEIVE_CAPS = ['report-status', 'report-status-v2', 'delete-refs', 'side-band-64k', 'quiet', 'ofs-delta', 'atomic', 'object-format=sha1', `agent=${AGENT}`];

/** The v0 receive-pack advertisement: real refs, or the capabilities^{} pseudo-ref for an empty repository. */
function receiveAdvertisement(repo: RepoRecord): Buffer {
  const refs = [...repo.refs.entries()];
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    lines.push(pkt(`${ZERO} capabilities^{}\0${RECEIVE_CAPS.join(' ')}\n`));
  } else {
    refs.forEach(([name, oid], index) => {
      const suffix = index === 0 ? `\0${RECEIVE_CAPS.join(' ')}` : '';
      lines.push(pkt(`${oid} ${name}${suffix}\n`));
    });
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

/** The v0 upload-pack advertisement, for clients that do not speak v2. */
function v0UploadAdvertisement(repo: RepoRecord): Buffer {
  const caps = ['multi_ack_detailed', 'side-band-64k', 'thin-pack', 'ofs-delta', 'no-progress', 'include-tag', `agent=${AGENT}`, 'object-format=sha1'];
  const refs = [...repo.refs.entries()];
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    lines.push(pkt(`${ZERO} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    refs.forEach(([name, oid], index) => {
      const suffix = index === 0 ? `\0${caps.join(' ')}` : '';
      lines.push(pkt(`${oid} ${name}${suffix}\n`));
    });
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------------

function handleLsRefs(repo: RepoRecord, args: readonly string[]): Buffer {
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const wantsPeel = args.some((line) => line === 'peel');
  const wantsSymrefs = args.some((line) => line === 'symrefs');
  const unborn = args.some((line) => line === 'unborn');
  const lines: Buffer[] = [];
  const refs = refList(repo);
  for (const ref of refs) {
    if (ref.name === 'HEAD' && prefixes.length > 0 && !prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) continue;
    if (ref.name !== 'HEAD' && prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantsPeel && ref.name !== 'HEAD') {
      const object = getObject(repo, ref.oid);
      if (object != null && object.type === 'tag') {
        const target = /^object ([0-9a-f]{40})/m.exec(object.body.toString('utf8'));
        if (target !== null) line += ` peeled:${target[1]}`;
      }
    }
    if (wantsSymrefs && ref.name === 'HEAD') line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    lines.push(pkt(`${line}\n`));
  }
  if (unborn && refs.length === 0) lines.push(pkt(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

/** Every object reachable from a tip: the commit, its trees, the blobs under them, and — for commits —
 * their parents, so a client's `have` line removes a whole slice of history from the pack. */
function collectFrom(repo: RepoRecord, tip: string, into: Set<string>, boundary: ReadonlySet<string> = new Set()): void {
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object == null) continue;
    into.add(oid);
    if (object.type === 'commit') {
      const text = object.body.toString('utf8');
      const tree = /^tree ([0-9a-f]{40})/m.exec(text);
      if (tree !== null) stack.push(tree[1]);
      // A shallow boundary's parents are exactly what the client does not hold.
      if (!boundary.has(oid)) for (const match of text.matchAll(/^parent ([0-9a-f]{40})/gm)) stack.push(match[1]);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.body)) stack.push(entry.sha);
    } else if (object.type === 'tag') {
      const target = /^object ([0-9a-f]{40})/m.exec(object.body.toString('utf8'));
      if (target !== null) stack.push(target[1]);
    }
  }
}

/** Whether `older` is an ancestor of (or equal to) `newer`. */
function isAncestor(repo: RepoRecord, older: string, newer: string): boolean {
  const seen = new Set<string>();
  const stack = [newer];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === older) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = getObject(repo, oid);
    if (object == null || object.type !== 'commit') continue;
    for (const match of object.body.toString('utf8').matchAll(/^parent ([0-9a-f]{40})/gm)) stack.push(match[1]);
  }
  return false;
}

/** Add a commit's tree and everything under it, skipping objects the client already holds. */
function addTreeObjects(repo: RepoRecord, oid: string, skip: ReadonlySet<string>, out: PackedObject[], seen: Set<string>): void {
  const stack = [oid];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current) || skip.has(current)) continue;
    const object = getObject(repo, current);
    if (object == null) continue;
    seen.add(current);
    out.push({ type: object.type, body: object.body, oid: current });
    if (object.type === 'tree') for (const entry of parseTree(object.body)) stack.push(entry.sha);
  }
}

function handleFetch(repo: RepoRecord, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth = 0;
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10) || 0;
    else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) continue;
  }

  // What the client already holds: everything reachable from its have lines.
  const held = new Set<string>();
  for (const have of haves) collectFrom(repo, have, held, new Set(clientShallow));

  // The commits to send, bounded by depth when the client asked for a shallow fetch.
  const commits: string[] = [];
  const boundary: string[] = [];
  if (depth > 0) {
    const seen = new Set<string>();
    let frontier = [...new Set(wants)];
    let level = 0;
    let deepest: string[] = [];
    while (frontier.length > 0 && level < depth) {
      const next: string[] = [];
      const current: string[] = [];
      for (const oid of frontier) {
        if (seen.has(oid)) continue;
        const object = getObject(repo, oid);
        if (object == null) continue;
        seen.add(oid);
        if (object.type !== 'commit') {
          const target = /^object ([0-9a-f]{40})/m.exec(object.body.toString('utf8'));
          if (target !== null) next.push(target[1]);
          continue;
        }
        current.push(oid);
        commits.push(oid);
        for (const match of object.body.toString('utf8').matchAll(/^parent ([0-9a-f]{40})/gm)) next.push(match[1]);
      }
      if (current.length > 0) deepest = current;
      frontier = next;
      level += 1;
    }
    // A commit is shallow when its parents are not part of what we send: the last level we walked.
    for (const oid of deepest) {
      const object = getObject(repo, oid);
      if (object == null) continue;
      if (/^parent [0-9a-f]{40}$/m.test(object.body.toString('utf8'))) boundary.push(oid);
    }
  } else {
    const seen = new Set<string>();
    const stack = [...wants];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = getObject(repo, oid);
      if (object == null) continue;
      if (object.type === 'commit') {
        seen.add(oid);
        commits.push(oid);
        for (const match of object.body.toString('utf8').matchAll(/^parent ([0-9a-f]{40})/gm)) stack.push(match[1]);
      } else if (object.type === 'tag') {
        const target = /^object ([0-9a-f]{40})/m.exec(object.body.toString('utf8'));
        if (target !== null) stack.push(target[1]);
      }
    }
  }

  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  if (haves.length > 0) {
    const common = haves.filter((oid) => held.has(oid));
    if (common.length > 0) {
      for (const oid of common) parts.push(pkt(`ACK ${oid}\n`));
      parts.push(pkt('ready\n'));
    } else {
      parts.push(pkt('NAK\n'));
    }
  } else {
    parts.push(pkt('NAK\n'));
  }
  parts.push(FLUSH);

  const unshallow = clientShallow.filter((oid) => !boundary.includes(oid) && commits.includes(oid));
  if (boundary.length > 0 || unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of boundary) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }

  const objects: PackedObject[] = [];
  const seen = new Set<string>(held);
  for (const oid of commits) {
    if (seen.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object == null) continue;
    seen.add(oid);
    objects.push({ type: object.type, body: object.body, oid });
    const tree = /^tree ([0-9a-f]{40})/m.exec(object.body.toString('utf8'));
    if (tree !== null) addTreeObjects(repo, tree[1], held, objects, seen);
  }
  for (const want of wants) {
    if (seen.has(want)) continue;
    const object = getObject(repo, want);
    if (object == null) continue;
    if (object.type === 'tag') {
      seen.add(want);
      objects.push({ type: 'tag', body: object.body, oid: want });
    } else if (commits.length === 0) {
      seen.add(want);
      objects.push({ type: object.type, body: object.body, oid: want });
    }
  }

  const pack = writePack(objects);
  parts.push(pkt('packfile\n'));
  const chunkSize = 65515;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    parts.push(sideband(1, pack.subarray(offset, Math.min(offset + chunkSize, pack.length))));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** POST git-upload-pack: a command list, then per-command sections. */
function handleUploadPack(repo: RepoRecord, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const output: Buffer[] = [];
  let index = 0;
  while (index < packets.length) {
    const packet = packets[index];
    if (packet.kind !== 'data') {
      index += 1;
      continue;
    }
    const command = packet.payload.toString('utf8').trim().replace(/^command=/, '');
    index += 1;
    const args: string[] = [];
    while (index < packets.length) {
      const next = packets[index];
      index += 1;
      if (next.kind === 'flush') break;
      if (next.kind === 'delim') continue;
      args.push(next.payload.toString('utf8').replace(/\n$/, ''));
    }
    if (command === 'ls-refs') output.push(handleLsRefs(repo, args));
    else if (command === 'fetch') output.push(handleFetch(repo, args));
    else if (command === 'object-info') output.push(FLUSH);
  }
  return Buffer.concat(output);
}

// ---------------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------------

/** Apply a push: unpack objects, then move refs, then answer report-status. */
function handleReceivePack(repo: RepoRecord, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const commands: Array<{ old: string; next: string; ref: string }> = [];
  let capabilities = '';
  let consumed = 0;
  for (const packet of packets) {
    consumed += packet.kind === 'data' ? packet.payload.length + 4 : 4;
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0) capabilities = text.slice(nul + 1).trim();
    const parts = line.trim().split(' ');
    if (parts.length !== 3) continue;
    commands.push({ old: parts[0], next: parts[1], ref: parts[2] });
  }
  const packBytes = body.subarray(consumed);
  const unpacked = packBytes.length > 4 ? readPack(repo, packBytes) : new Map<string, PackedObject>();
  let unpackError: string | null = null;
  for (const object of unpacked.values()) {
    putObject(repo, object.type, object.body);
  }
  const report: string[] = [unpackError === null ? 'unpack ok' : `unpack ${unpackError}`];
  for (const command of commands) {
    const current = command.ref === 'HEAD' ? refOid(repo, 'HEAD') : (repo.refs.get(command.ref) ?? null);
    const currentText = current ?? ZERO;
    if (command.old !== ZERO && command.old !== currentText) {
      report.push(`ng ${command.ref} stale info`);
      continue;
    }
    if (command.next === ZERO) {
      if (current === null) {
        report.push(`ng ${command.ref} no such ref`);
        continue;
      }
      repo.refs.delete(command.ref);
      report.push(`ok ${command.ref}`);
      continue;
    }
    if (unpacked.size === 0 && getObject(repo, command.next) == null) {
      report.push(`ng ${command.ref} missing object ${command.next}`);
      continue;
    }
    if (current !== null && !isAncestor(repo, current, command.next)) {
      report.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.next);
    if (command.ref.startsWith('refs/heads/') && repo.refs.size === 1) repo.defaultBranch = command.ref.slice('refs/heads/'.length);
    report.push(`ok ${command.ref}`);
  }
  const inner = Buffer.concat([...report.map((line) => pkt(`${line}\n`)), FLUSH]);
  const sidebandWanted = capabilities.split(' ').includes('side-band-64k');
  if (!sidebandWanted) return inner;
  const chunks: Buffer[] = [];
  const chunkSize = 65500;
  for (let offset = 0; offset < inner.length; offset += chunkSize) {
    chunks.push(sideband(1, inner.subarray(offset, Math.min(offset + chunkSize, inner.length))));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------------

/** Answer one git request, or false when the path is not a git path we know. */
export async function handleGit(ctx: GitCtx): Promise<boolean> {
  const { req, res, method, segments, query } = ctx;
  const gitIndex = segments.findIndex((segment) => segment.endsWith('.git'));
  if (gitIndex < 1) return false;
  const owner = segments[gitIndex - 1];
  const name = segments[gitIndex].slice(0, -'.git'.length);
  const rest = segments.slice(gitIndex + 1);
  const repo = repoFor(owner, name);
  if (repo === null) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('repository not found\n');
    return true;
  }
  const service = query.get('service') ?? '';
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    if (service === 'git-upload-pack') {
      advertisementHeaders(res, service);
      const wantsV2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
      if (wantsV2) res.end(v2Advertisement());
      else res.end(Buffer.concat([pkt(`# service=${service}\n`), FLUSH, v0UploadAdvertisement(repo)]));
      return true;
    }
    if (service === 'git-receive-pack') {
      advertisementHeaders(res, service);
      res.end(Buffer.concat([pkt(`# service=${service}\n`), FLUSH, receiveAdvertisement(repo)]));
      return true;
    }
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('smart HTTP only\n');
    return true;
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    const body = await readAll(req);
    gitHeaders(res, 'git-upload-pack', handleUploadPack(repo, body));
    return true;
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    const body = await readAll(req);
    gitHeaders(res, 'git-receive-pack', handleReceivePack(repo, body));
    return true;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
  return true;
}