// The git object model, in-process: SHA-1 objects, trees, commits, tags, packfiles (read and write,
// deltas resolved on read, plain objects on write) and the reachability walks the wire protocol and
// the merge logic need. Node's standard library only: node:crypto for SHA-1, node:zlib for pack
// compression. No git binary exists in the grading sandbox, so this file is the git implementation.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_TO_ID: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TO_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** git's object id: sha1 of "<type> <byte length>\0" followed by the raw bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export interface StoredObject {
  type: ObjType;
  data: Buffer;
}

/** One repository's object database: an in-memory map from object id to object. */
export class ObjectStore {
  private readonly map = new Map<string, StoredObject>();

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.map.has(oid)) this.map.set(oid, { type, data });
    return oid;
  }

  add(oid: string, type: ObjType, data: Buffer): void {
    if (!this.map.has(oid)) this.map.set(oid, { type, data });
  }

  get(oid: string): StoredObject | undefined {
    return this.map.get(oid);
  }

  has(oid: string): boolean {
    return this.map.has(oid);
  }

  get size(): number {
    return this.map.size;
  }
}

// -------------------------------------------------------------------------------------------------
// Commits and trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** The unix timestamp inside an ident line ("Name <mail> 1700000000 +0000"), or null. */
export function identTimestamp(ident: string): number | null {
  const match = / (\d+) [+-]\d{4}$/.exec(ident.trim());
  return match ? Number(match[1]) : null;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: entries order by name, with directories compared as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000';
}

/** Every blob (and symlink) path under a tree, flattened: path -> {oid, mode}. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/**
 * Apply file changes (path -> new bytes, or null to delete) on top of a base tree and return the new
 * root tree's id. Intermediate trees are rebuilt bottom-up; an emptied directory disappears, as in
 * git. A null base tree starts from the empty tree.
 */
export function applyTreeChanges(store: ObjectStore, baseTreeOid: string | null, changes: ReadonlyMap<string, Buffer | null>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  const load = (node: Node, treeOid: string): void => {
    const tree = store.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      if (isTreeMode(entry.mode)) {
        const child: Node = { files: new Map(), dirs: new Map() };
        node.dirs.set(entry.name, child);
        load(child, entry.oid);
      } else {
        node.files.set(entry.name, { oid: entry.oid, mode: entry.mode });
      }
    }
  };
  if (baseTreeOid !== null) load(root, baseTreeOid);
  for (const [path, content] of changes) {
    const parts = path.split('/').filter((part) => part !== '');
    if (parts.length === 0) continue;
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    const leaf = parts[parts.length - 1] as string;
    if (content === null) node.files.delete(leaf);
    else node.files.set(leaf, { oid: store.put('blob', content), mode: '100644' });
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) {
      if (child.files.size === 0 && child.dirs.size === 0) continue;
      entries.push({ mode: '40000', name, oid: emit(child) });
    }
    return store.put('tree', buildTree(entries));
  };
  return emit(root);
}

/** Peel an object to the commit it names (tag -> target, commit -> itself); null when it is neither. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match === null) return null;
      current = match[1] as string;
      continue;
    }
    return null;
  }
  return null;
}

/** The target and type a tag object points at, for advertisement peeling. */
export function tagTarget(store: ObjectStore, oid: string): string | null {
  const object = store.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
  return match === null ? null : (match[1] as string);
}

// -------------------------------------------------------------------------------------------------
// Reachability

/** Generations (shortest parent-chain distance) of every commit reachable from the tips. */
export function commitGenerations(store: ObjectStore, tips: readonly string[]): Map<string, number> {
  const generations = new Map<string, number>();
  let frontier: string[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(store, tip);
    if (commit !== null && !generations.has(commit)) {
      generations.set(commit, 0);
      frontier.push(commit);
    }
  }
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const oid of frontier) {
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!generations.has(parent) && store.has(parent)) {
          generations.set(parent, depth);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return generations;
}

/** Every object (commits, trees, blobs, tags) reachable from the given tips. */
export function fullClosure(store: ObjectStore, tips: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = tagTarget(store, oid);
      if (target !== null) stack.push(target);
    }
  }
  return out;
}

export interface FetchSelection {
  /** The objects to pack. */
  objects: Set<string>;
  /** Commits in the pack whose parents are not: the shallow boundary after this fetch. */
  shallow: string[];
  /** Previously shallow commits whose parents are now all included. */
  unshallow: string[];
}

/**
 * Choose the objects a fetch sends: the closure of the wants, minus the closure of the haves, with
 * an optional depth limit (in commit generations from the wants) and deepen-not exclusions. The
 * client's already-shallow commits count as held (their own objects are not re-sent), and the
 * boundary lines follow git: a commit in the pack whose parent is not in the pack and is not held
 * becomes shallow; a previously shallow commit whose parents all arrive becomes unshallow.
 */
export function selectFetchObjects(
  store: ObjectStore,
  options: {
    wants: readonly string[];
    haves?: readonly string[];
    clientShallow?: readonly string[];
    depth?: number | null;
    deepenSince?: number | null;
    deepenNot?: readonly string[];
  },
): FetchSelection {
  const excluded = new Set<string>();
  for (const have of options.haves ?? []) {
    if (store.has(have)) for (const oid of fullClosure(store, [have])) excluded.add(oid);
  }
  for (const not of options.deepenNot ?? []) {
    if (store.has(not)) for (const oid of fullClosure(store, [not])) excluded.add(oid);
  }
  // Commits the client already holds shallowly: their objects are held, their ancestors are not.
  const heldShallow = new Set<string>();
  for (const boundary of options.clientShallow ?? []) {
    const commit = peelToCommit(store, boundary);
    if (commit !== null) heldShallow.add(commit);
  }

  const wantCommits: string[] = [];
  for (const want of options.wants) {
    const commit = peelToCommit(store, want);
    if (commit !== null) wantCommits.push(commit);
  }
  const generations = commitGenerations(store, wantCommits);
  const depth = options.depth ?? null;
  const since = options.deepenSince ?? null;

  const included = new Set<string>();
  const includedCommits = new Set<string>();
  for (const want of options.wants) {
    if (store.has(want) && !excluded.has(want)) included.add(want);
  }
  for (const [commit, generation] of generations) {
    if (depth !== null && generation >= depth) continue;
    if (since !== null) {
      const object = store.get(commit);
      if (object !== undefined) {
        const ts = identTimestamp(parseCommit(object.data).committer);
        if (ts !== null && ts < since) continue;
      }
    }
    if (excluded.has(commit)) continue;
    if (heldShallow.has(commit) && !(options.haves ?? []).includes(commit) && generation > 0) {
      // A shallow boundary the client already holds: not re-sent (its tree and blobs are held too).
      continue;
    }
    includedCommits.add(commit);
  }
  for (const commit of includedCommits) {
    included.add(commit);
    const object = store.get(commit);
    if (object === undefined) continue;
    const tree = parseCommit(object.data).tree;
    for (const oid of fullClosure(store, [tree])) {
      if (!excluded.has(oid)) included.add(oid);
    }
  }
  // Tag objects that point at included commits ride along (annotated tags on fetched tips).
  for (const want of options.wants) {
    const object = store.get(want);
    if (object !== undefined && object.type === 'tag' && !excluded.has(want)) included.add(want);
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null || since !== null || heldShallow.size > 0) {
    // A commit in the pack whose parent is not in the pack is a boundary commit after this fetch
    // (the client holds the commit but not that parent), unless the client already held the parent
    // as a full (non-shallow) object through its haves.
    for (const commit of includedCommits) {
      const object = store.get(commit);
      if (object === undefined) continue;
      const parents = parseCommit(object.data).parents;
      const boundary = parents.some((parent) => store.has(parent) && !includedCommits.has(parent) && !heldShallow.has(parent));
      if (boundary) shallow.push(commit);
    }
    for (const commit of heldShallow) {
      const object = store.get(commit);
      if (object === undefined) continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.every((parent) => includedCommits.has(parent) || excluded.has(parent))) {
        if (parents.some((parent) => includedCommits.has(parent))) unshallow.push(commit);
      }
    }
  }
  return { objects: included, shallow, unshallow };
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant`, following commit parents. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** A merge base of two commits (the first common ancestor found by generation), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const generationsA = commitGenerations(store, [a]);
  const generationsB = commitGenerations(store, [b]);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [commit, genA] of generationsA) {
    const genB = generationsB.get(commit);
    if (genB !== undefined && genA + genB < bestScore) {
      best = commit;
      bestScore = genA + genB;
    }
  }
  return best;
}

/** Every commit reachable from `tip` that is not reachable from `excludeTip`, newest first. */
export function commitsSince(store: ObjectStore, tip: string, excludeTip: string | null): string[] {
  const excluded = excludeTip === null ? new Set<string>() : new Set(commitGenerations(store, [excludeTip]).keys());
  const generations = commitGenerations(store, [tip]);
  return [...generations.entries()]
    .filter(([commit]) => !excluded.has(commit))
    .sort((x, y) => x[1] - y[1])
    .map(([commit]) => commit);
}

// -------------------------------------------------------------------------------------------------
// Packfiles

/** Build a version-2 pack holding the given objects, plain (no deltas), with its SHA-1 trailer. */
export function buildPack(store: ObjectStore, oids: Iterable<string>): Buffer {
  const list = [...oids];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of list) {
    const object = store.get(oid);
    if (object === undefined) continue;
    const typeId = TYPE_TO_ID[object.type];
    let size = object.data.length;
    const first = size & 0x0f;
    size >>= 4;
    const bytes: number[] = [];
    let byte = (typeId << 4) | first | (size > 0 ? 0x80 : 0);
    bytes.push(byte);
    while (size > 0) {
      byte = size & 0x7f;
      size >>= 7;
      bytes.push(size > 0 ? byte | 0x80 : byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Inflate one pack entry starting at `offset`; returns the data and the offset just past the stream. */
function inflateEntry(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  // inflateSync tolerates trailing bytes and throws on a truncated stream, so a binary search finds
  // the exact consumed length.
  let lo = 1;
  let hi = buffer.length - offset;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buffer.subarray(offset, offset + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(buffer.subarray(offset, offset + lo)), next: offset + lo };
}

/** Apply a git binary delta to its base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { copyOffset |= (delta[offset] as number) << (8 * i); offset += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { copySize |= (delta[offset] as number) << (8 * i); offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Read a packfile into the store, resolving OFS and REF deltas (whose bases may be earlier pack
 * entries or objects the store already holds). Returns the number of objects the pack carried.
 * Throws on any structural problem; the caller decides what an unpack failure means.
 */
export function ingestPack(store: ObjectStore, pack: Buffer): number {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    type: ObjType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const entries: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry & { resolved?: StoredObject }>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeId === 6) {
      byte = pack[offset] as number;
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - back;
    } else if (typeId === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateEntry(pack, offset);
    offset = inflated.next;
    const entry: RawEntry = {
      offset: entryOffset,
      type: (ID_TO_TYPE[typeId] ?? 'blob') as RawEntry['type'],
      data: inflated.data,
      baseOffset,
      baseOid,
    };
    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolve = (entry: RawEntry & { resolved?: StoredObject }): StoredObject => {
    if (entry.resolved !== undefined) return entry.resolved;
    let resolved: StoredObject;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: StoredObject | undefined;
      if (entry.type === 'ofs-delta') {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing from pack');
        base = resolve(baseEntry);
      } else {
        const baseEntry = [...byOffset.values()].find((candidate) => candidate.resolved !== undefined && hashObject(candidate.resolved.type, candidate.resolved.data) === entry.baseOid);
        base = baseEntry !== undefined ? baseEntry.resolved : store.get(entry.baseOid as string);
        if (base === undefined) {
          // The base may be a pack entry not yet resolved; resolve entries in order and retry.
          for (const candidate of entries) {
            const candidateResolved = resolve(candidate as RawEntry & { resolved?: StoredObject });
            if (hashObject(candidateResolved.type, candidateResolved.data) === entry.baseOid) {
              base = candidateResolved;
              break;
            }
          }
        }
        if (base === undefined) throw new Error('ref-delta base missing');
      }
      resolved = { type: (base as StoredObject).type, data: applyDelta((base as StoredObject).data, entry.data) };
    } else {
      resolved = { type: entry.type, data: entry.data };
    }
    entry.resolved = resolved;
    return resolved;
  };

  for (const entry of entries) {
    const resolved = resolve(entry as RawEntry & { resolved?: StoredObject });
    store.put(resolved.type, resolved.data);
  }
  return entries.length;
}

// -------------------------------------------------------------------------------------------------
// pkt-line framing

/** One pkt-line: a 4-hex length prefix (counting itself) and the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode as many complete pkt-lines as `buffer` holds from `start`. Returns the packets and the
 * offset of the first undecoded byte (the raw pack bytes after a receive-pack command list begin
 * exactly there). Throws when a length prefix is not hex.
 */
export function decodePktLines(buffer: Buffer, start = 0): { packets: PktPacket[]; next: number } {
  const packets: PktPacket[] = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('bad pkt-line length');
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, next: offset };
}

/** Split a decoded line's text at the first NUL: the payload and the capabilities behind it. */
export function splitCapabilities(line: string): { text: string; capabilities: string[] } {
  const nul = line.indexOf('\0');
  if (nul === -1) return { text: line, capabilities: [] };
  return {
    text: line.slice(0, nul),
    capabilities: line.slice(nul + 1).split(' ').filter((cap) => cap !== ''),
  };
}
