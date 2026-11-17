// The git smart-HTTP transport, spoken in-process against the object store: info/refs
// advertisements (protocol v0 and v2), ls-refs and fetch over protocol v2, fetch over v0, and
// receive-pack pushes with report-status. There is no git binary in the sandbox; gitcore.ts is the
// object model and this file is the wire.

import {
  PKT_FLUSH,
  ZERO_OID,
  buildPack,
  decodePktLines,
  ingestPack,
  isAncestor,
  pktLine,
  selectFetchObjects,
  splitCapabilities,
  tagTarget,
  type PktPacket,
} from './gitcore.ts';
import { forge, headRef, type RepoRec } from './store.ts';

export interface GitHttpRequest {
  method: string;
  owner: string;
  repo: string;
  /** 'info/refs' | 'git-upload-pack' | 'git-receive-pack' */
  endpoint: string;
  query: URLSearchParams;
  /** The Git-Protocol header's value, when sent ('version=2' selects protocol v2). */
  gitProtocol: string | null;
  body: Buffer;
  authed: boolean;
}

export interface GitHttpReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'makefun-forge/1.0';
const UPLOAD_CAPS_V0 = [
  'multi_ack_detailed',
  'side-band-64k',
  'thin-pack',
  'ofs-delta',
  'shallow',
  'deepen-since',
  'deepen-not',
  `agent=${AGENT}`,
];
const RECEIVE_CAPS = ['report-status', 'report-status-v2', 'delete-refs', 'side-band-64k', 'ofs-delta', `agent=${AGENT}`];

function textReply(status: number, text: string): GitHttpReply {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

function jsonReply(status: number, message: string): GitHttpReply {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

/** The ref lines an advertisement or ls-refs answer carries, in git's order (HEAD first). */
function advertisedRefs(repo: RepoRec): { name: string; oid: string; peeled?: string }[] {
  const out: { name: string; oid: string; peeled?: string }[] = [];
  const head = repo.refs.get(headRef(repo));
  if (head !== undefined) out.push({ name: 'HEAD', oid: head });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    out.push({ name, oid });
    if (name.startsWith('refs/tags/')) {
      const target = tagTarget(repo.objects, oid);
      if (target !== null && target !== oid) out.push({ name: `${name}^{}`, oid: target });
    }
  }
  return out;
}

function infoRefs(req: GitHttpRequest, repo: RepoRec): GitHttpReply {
  const service = req.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return textReply(400, 'unknown service');
  }
  const isUpload = service === 'git-upload-pack';
  const wantsV2 = isUpload && (req.gitProtocol ?? '').includes('version=2');
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (wantsV2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
  }
  const caps = isUpload
    ? [...UPLOAD_CAPS_V0, `symref=HEAD:${headRef(repo)}`]
    : RECEIVE_CAPS;
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps.join(' ')}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
}

/** Parse a pkt-line request body into its data lines (text form), stopping at the first flush. */
function requestLines(body: Buffer): { lines: string[]; rest: Buffer } {
  const { packets, next } = decodePktLines(body);
  const lines: string[] = [];
  let consumed = 0;
  let offset = 0;
  for (const packet of packets) {
    // Recompute the byte span of each packet to find where the pack (if any) begins.
    if (packet.kind === 'flush') {
      consumed = offset + 4;
      break;
    }
    if (packet.kind === 'delim') {
      offset += 4;
      lines.push('\x01');
      continue;
    }
    if (packet.kind === 'response-end') {
      offset += 4;
      continue;
    }
    offset += 4 + packet.payload.length;
    lines.push(packet.payload.toString('utf8'));
  }
  if (consumed === 0) consumed = next;
  return { lines, rest: body.subarray(consumed) };
}

/** Split request lines at the delim marker: capability lines before it, argument lines after. */
function splitAtDelim(lines: string[]): { head: string[]; args: string[] } {
  const index = lines.indexOf('\x01');
  if (index === -1) return { head: lines, args: [] };
  return { head: lines.slice(0, index), args: lines.slice(index + 1) };
}

function lsRefs(req: GitHttpRequest, repo: RepoRec): GitHttpReply {
  const { lines } = requestLines(req.body);
  const { args } = splitAtDelim(lines);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTarget = headRef(repo);
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid === undefined) {
      if (unborn) parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
      else if (symrefs) parts.push(pktLine(`${ZERO_OID} HEAD symref-target:${headTarget}\n`));
    } else {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let suffix = '';
    if (peel && name.startsWith('refs/tags/')) {
      const target = tagTarget(repo.objects, oid);
      if (target !== null && target !== oid) suffix = ` peeled:${target}`;
    }
    parts.push(pktLine(`${oid} ${name}${suffix}\n`));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], clientShallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) out.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) out.depth = Number(line.slice(7));
    else if (line.startsWith('deepen-since ')) out.deepenSince = Number(line.slice(13));
    else if (line.startsWith('deepen-not ')) out.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') out.done = true;
  }
  return out;
}

/** Wrap pack bytes in sideband-1 pkt-lines (with the odd progress note on band 2 suppressed). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
    return parts;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  return parts;
}

function fetchV2(req: GitHttpRequest, repo: RepoRec): GitHttpReply {
  const { lines } = requestLines(req.body);
  const { args } = splitAtDelim(lines);
  const fetch = parseFetchArgs(args);
  const selection = selectFetchObjects(repo.objects, {
    wants: fetch.wants,
    haves: fetch.haves,
    clientShallow: fetch.clientShallow,
    depth: fetch.depth,
    deepenSince: fetch.deepenSince,
    deepenNot: fetch.deepenNot,
  });
  const parts: Buffer[] = [];
  if (fetch.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const found = fetch.haves.filter((have) => repo.objects.has(have));
    if (found.length === 0) parts.push(pktLine('NAK\n'));
    else for (const have of found) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(PKT_FLUSH);
  }
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(buildPack(repo.objects, selection.objects)));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchV0(req: GitHttpRequest, repo: RepoRec): GitHttpReply {
  // Two sections: wants (flush) then haves/done (flush). Parse them in order.
  const first = decodePktLines(req.body);
  const wantLines: string[] = [];
  const haveLines: string[] = [];
  let section = 0;
  for (const packet of first.packets as PktPacket[]) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) wantLines.push(line);
    else haveLines.push(line);
  }
  const wants: string[] = [];
  let depth: number | null = null;
  let deepenSince: number | null = null;
  const deepenNot: string[] = [];
  const clientShallow: string[] = [];
  for (const line of wantLines) {
    const { text } = splitCapabilities(line);
    if (text.startsWith('want ')) wants.push(text.slice(5).trim().split(' ')[0] as string);
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7));
    else if (text.startsWith('deepen-since ')) deepenSince = Number(text.slice(13));
    else if (text.startsWith('deepen-not ')) deepenNot.push(text.slice(11).trim());
    else if (text.startsWith('shallow ')) clientShallow.push(text.slice(8).trim());
  }
  const haves: string[] = [];
  for (const line of haveLines) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const selection = selectFetchObjects(repo.objects, { wants, haves, clientShallow, depth, deepenSince, deepenNot });
  const parts: Buffer[] = [];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const found = haves.filter((have) => repo.objects.has(have));
  if (found.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const have of found) parts.push(pktLine(`ACK ${have} common\n`));
    parts.push(pktLine(`ACK ${found[found.length - 1]} ready\n`));
  }
  parts.push(PKT_FLUSH);
  parts.push(...sidebandPack(buildPack(repo.objects, selection.objects)));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function uploadPack(req: GitHttpRequest, repo: RepoRec): GitHttpReply {
  if ((req.gitProtocol ?? '').includes('version=2')) {
    // The command is the first line, before the delim.
    let command = '';
    try {
      const { lines } = requestLines(req.body);
      command = (lines[0] ?? '').replace(/\n$/, '');
    } catch {
      return textReply(400, 'bad request');
    }
    if (command === 'command=ls-refs') return lsRefs(req, repo);
    if (command === 'command=fetch') return fetchV2(req, repo);
    return textReply(400, 'unknown command');
  }
  return fetchV0(req, repo);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(req: GitHttpRequest, repo: RepoRec): GitHttpReply {
  let commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let pack = Buffer.alloc(0);
  try {
    const { packets, next } = decodePktLines(req.body);
    let offset = 0;
    let sawFlush = false;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        offset += 4;
        sawFlush = true;
        break;
      }
      if (packet.kind !== 'data') {
        offset += 4;
        continue;
      }
      offset += 4 + packet.payload.length;
      const rawLine = packet.payload.toString('utf8').replace(/\n$/, '');
      const { text, capabilities: caps } = splitCapabilities(rawLine);
      if (commands.length === 0 && caps.length > 0) capabilities = caps;
      const parts = text.split(' ');
      if (parts.length === 3) {
        commands.push({ oldOid: (parts[0] as string).toLowerCase(), newOid: (parts[1] as string).toLowerCase(), ref: parts[2] as string });
      }
    }
    if (sawFlush) pack = req.body.subarray(offset);
    else if (packets.length > 0 && commands.length === 0) throw new Error('no commands');
    void next;
  } catch {
    return textReply(400, 'bad request');
  }

  const store = repo.objects;
  let unpackOk = true;
  if (pack.length > 0) {
    try {
      ingestPack(store, pack);
    } catch {
      unpackOk = false;
    }
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok' : 'unpack index-pack failed'];
  for (const command of commands) {
    const fail = (reason: string): void => {
      reportLines.push(`ng ${command.ref} ${reason}`);
    };
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    if (command.oldOid !== current) {
      fail(`reference is at ${current} but expected ${command.oldOid}`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete. Refusing to delete the branch HEAD points at, as git does.
      if (command.ref === headRef(repo)) {
        fail('deletion of the current branch prohibited');
        continue;
      }
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}`);
      continue;
    }
    const target = store.get(command.newOid);
    if (target === undefined) {
      fail('missing objects');
      continue;
    }
    if (command.oldOid !== ZERO_OID) {
      const oldCommit = store.get(command.oldOid);
      if (oldCommit !== undefined && target.type === 'commit' && oldCommit.type === 'commit') {
        if (!isAncestor(store, command.oldOid, command.newOid)) {
          fail('non-fast-forward');
          continue;
        }
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }

  const inner = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  let body: Buffer;
  if (capabilities.includes('side-band-64k')) {
    // The report stream rides band 1, itself pkt-lined inside the outer framing.
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < inner.length; offset += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(offset, offset + CHUNK)])));
    }
    parts.push(PKT_FLUSH);
    body = Buffer.concat(parts);
  } else {
    body = inner;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
}

/** Handle one smart-HTTP request. Always answers; never throws. */
export function handleGitHttp(req: GitHttpRequest): GitHttpReply {
  if (!req.authed) return jsonReply(401, 'Requires authentication');
  const repo = forge.getRepo(req.owner, req.repo);
  if (repo === undefined) return jsonReply(404, 'Not Found');
  if (req.endpoint === 'info/refs' && req.method === 'GET') return infoRefs(req, repo);
  if (req.endpoint === 'git-upload-pack' && req.method === 'POST') {
    try {
      return uploadPack(req, repo);
    } catch {
      return textReply(400, 'bad request');
    }
  }
  if (req.endpoint === 'git-receive-pack' && req.method === 'POST') return receivePack(req, repo);
  return jsonReply(404, 'Not Found');
}
