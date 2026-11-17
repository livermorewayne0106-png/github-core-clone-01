// The forge's state and the operations every surface shares: repositories with their object
// databases and refs, commits made through the contents API, three-way merges for pull requests,
// issues, comments, labels and pull requests. Everything lives in memory; every timestamp comes
// from the trial's fixed now (MAKEFUN_TRIAL_NOW), never the wall clock, so two runs of a trial see
// byte-identical answers.

import {
  ObjectStore,
  applyTreeChanges,
  buildCommit,
  commitsSince,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  type CommitInfo,
} from './gitcore.ts';

/** The one user the trial's bearer token belongs to (the suite's scenario viewer). */
export const OWNER_LOGIN = 'adaiversen';
export const OWNER_ID = 1000;

/** The trial's fixed now, parsed from MAKEFUN_TRIAL_NOW (RFC 3339 or epoch milliseconds). */
function trialNowMs(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    return value > 100_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  return Date.parse('2026-11-14T00:00:00Z');
}

export const NOW_MS = trialNowMs();
export const NOW_ISO = new Date(NOW_MS).toISOString();
export const NOW_SEC = Math.floor(NOW_MS / 1000);

/** The commit identity the forge writes with (the token owner's, at the trial's now). */
export const FORGE_IDENT = `${OWNER_LOGIN} <${OWNER_LOGIN}@example.invalid> ${NOW_SEC} +0000`;

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  seq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: ObjectStore;
  /** Full ref name (refs/heads/x, refs/tags/y) -> object id. HEAD is `refs/heads/<defaultBranch>`. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  nextCommentId: number;
  seq: number;
}

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  private repoCounter = 1000;
  private seqCounter = 0;

  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  createRepo(owner: string, name: string, init: { private?: boolean; description?: string }): RepoRec | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    this.repoCounter += 1;
    const repo: RepoRec = {
      id: this.repoCounter,
      owner,
      name,
      private: init.private ?? false,
      description: init.description ?? '',
      defaultBranch: 'main',
      objects: new ObjectStore(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      seq: this.nextSeq(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  reposOf(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.seq - b.seq);
  }
}

export const forge = new Forge();

// -------------------------------------------------------------------------------------------------
// Refs and commits

export function headRef(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Resolve a REST `ref`/`sha` parameter: a branch name, a full ref, a tag, or a raw commit id. */
export function resolveCommitish(repo: RepoRec, value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') {
    const tip = repo.refs.get(headRef(repo));
    return tip === undefined ? null : peelToCommit(repo.objects, tip);
  }
  const candidates = [
    repo.refs.get(value),
    repo.refs.get(`refs/heads/${value}`),
    repo.refs.get(`refs/tags/${value}`),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined) return peelToCommit(repo.objects, candidate);
  }
  if (repo.objects.has(value)) return peelToCommit(repo.objects, value);
  return null;
}

/** Make a commit on a branch from flattened path changes and move the branch. Returns the commit id. */
export function commitChanges(
  repo: RepoRec,
  branch: string,
  changes: ReadonlyMap<string, Buffer | null>,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  const parentTip = repo.refs.get(ref) ?? null;
  const parentCommit = parentTip === null ? null : peelToCommit(repo.objects, parentTip);
  const baseTree = parentCommit === null ? null : parseCommit((repo.objects.get(parentCommit) as { data: Buffer }).data).tree;
  const tree = applyTreeChanges(repo.objects, baseTree, changes);
  const info: CommitInfo = {
    tree,
    parents: parentCommit === null ? [] : [parentCommit],
    author: FORGE_IDENT,
    committer: FORGE_IDENT,
    message,
  };
  const oid = repo.objects.put('commit', buildCommit(info));
  repo.refs.set(ref, oid);
  return oid;
}

/** The blob at a path on a commit, or null. */
export function blobAtCommit(repo: RepoRec, commitOid: string, path: string): { oid: string; data: Buffer } | null {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  const tree = parseCommit(commit.data).tree;
  const flat = flattenTree(repo.objects, tree);
  const entry = flat.get(path);
  if (entry === undefined) return null;
  const blob = repo.objects.get(entry.oid);
  if (blob === undefined) return null;
  return { oid: entry.oid, data: blob.data };
}

/** Directory listing at a path on a commit: immediate children, files and subdirectories. */
export function listAtCommit(
  repo: RepoRec,
  commitOid: string,
  dirPath: string,
): { name: string; path: string; type: 'file' | 'dir'; oid: string }[] | null {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  const tree = parseCommit(commit.data).tree;
  const flat = flattenTree(repo.objects, tree);
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const entries = new Map<string, { name: string; path: string; type: 'file' | 'dir'; oid: string }>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      entries.set(rest, { name: rest, path, type: 'file', oid: entry.oid });
    } else {
      const dirName = rest.slice(0, slash);
      if (!entries.has(dirName)) {
        entries.set(dirName, { name: dirName, path: `${prefix}${dirName}`, type: 'dir', oid: subtreeOid(repo, tree, `${prefix}${dirName}`) });
      }
    }
  }
  if (entries.size === 0 && dirPath !== '') return null;
  return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The tree id of a directory inside a root tree (used for directory listings' sha fields). */
function subtreeOid(repo: RepoRec, rootTree: string, dirPath: string): string {
  let current = rootTree;
  for (const part of dirPath.split('/').filter((part) => part !== '')) {
    const tree = repo.objects.get(current);
    if (tree === undefined || tree.type !== 'tree') return current;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === part);
    if (entry === undefined) return current;
    current = entry.oid;
  }
  return current;
}

// -------------------------------------------------------------------------------------------------
// Merging

export interface MergeOutcome {
  tree: string;
  conflicts: string[];
}

/**
 * A three-way merge of `headCommit` into `baseCommit` over their merge base, per file: a path one
 * side changed takes that side's version; a path both sides changed differently conflicts. Returns
 * the merged tree (built even when conflicts exist, with the base version kept at conflicted paths)
 * and the conflicted paths.
 */
export function mergeTrees(repo: RepoRec, baseCommit: string, headCommit: string): MergeOutcome {
  const store = repo.objects;
  const base = mergeBase(store, baseCommit, headCommit) ?? baseCommit;
  const flatten = (commit: string): Map<string, { oid: string; mode: string }> => {
    const object = store.get(commit);
    if (object === undefined || object.type !== 'commit') return new Map();
    return flattenTree(store, parseCommit(object.data).tree);
  };
  const baseFlat = flatten(base);
  const oursFlat = flatten(baseCommit);
  const theirsFlat = flatten(headCommit);
  const paths = new Set<string>([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  const changes = new Map<string, Buffer | null>();
  const conflicts: string[] = [];
  const same = (x: { oid: string } | undefined, y: { oid: string } | undefined): boolean => x?.oid === y?.oid;
  for (const path of paths) {
    const inBase = baseFlat.get(path);
    const inOurs = oursFlat.get(path);
    const inTheirs = theirsFlat.get(path);
    const oursChanged = !same(inBase, inOurs);
    const theirsChanged = !same(inBase, inTheirs);
    let winner = inOurs;
    if (theirsChanged && !oursChanged) winner = inTheirs;
    else if (theirsChanged && oursChanged) {
      if (same(inOurs, inTheirs)) winner = inOurs;
      else {
        conflicts.push(path);
        winner = inOurs;
      }
    }
    if (!same(winner, inOurs)) {
      if (winner === undefined) changes.set(path, null);
      else {
        const blob = store.get(winner.oid);
        if (blob !== undefined) changes.set(path, blob.data);
      }
    }
  }
  const baseTree = parseCommit((store.get(baseCommit) as { data: Buffer }).data).tree;
  const tree = applyTreeChanges(store, baseTree, changes);
  return { tree, conflicts };
}

/** Whether merging `headCommit` into `baseCommit` would conflict. */
export function mergeConflicts(repo: RepoRec, baseCommit: string, headCommit: string): boolean {
  if (isAncestor(repo.objects, headCommit, baseCommit)) return false;
  return mergeTrees(repo, baseCommit, headCommit).conflicts.length > 0;
}

export interface PullFileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level additions/deletions between two blob versions, by longest common subsequence. */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : countLines(oldData);
  const newLines = newData === null ? [] : countLines(newData);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  // LCS over lines, capped: files in this forge are small; a generous cap keeps the worst case sane.
  const cap = 4000;
  if (oldLines.length * newLines.length > cap * cap) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const widths = newLines.length + 1;
  const dp = new Uint32Array((oldLines.length + 1) * widths);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i * widths + j] = oldLines[i] === newLines[j]
        ? (dp[(i + 1) * widths + j + 1] as number) + 1
        : Math.max(dp[(i + 1) * widths + j] as number, dp[i * widths + j + 1] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/** The changed files of a pull request: merge base of head/base tips against the head tip. */
export function pullFiles(repo: RepoRec, pull: PullRec): PullFileChange[] {
  const store = repo.objects;
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const headCommit = peelToCommit(store, headTip);
  const baseCommit = peelToCommit(store, baseTip);
  if (headCommit === null || baseCommit === null) return [];
  const base = mergeBase(store, baseCommit, headCommit) ?? baseCommit;
  const flatten = (commit: string): Map<string, { oid: string; mode: string }> => {
    const object = store.get(commit);
    if (object === undefined || object.type !== 'commit') return new Map();
    return flattenTree(store, parseCommit(object.data).tree);
  };
  const fromFlat = flatten(base);
  const toFlat = flatten(headCommit);
  const paths = new Set<string>([...fromFlat.keys(), ...toFlat.keys()]);
  const out: PullFileChange[] = [];
  for (const path of [...paths].sort()) {
    const from = fromFlat.get(path);
    const to = toFlat.get(path);
    if (from?.oid === to?.oid) continue;
    const oldData = from === undefined ? null : (store.get(from.oid)?.data ?? null);
    const newData = to === undefined ? null : (store.get(to.oid)?.data ?? null);
    const { additions, deletions } = lineDiff(oldData, newData);
    out.push({
      filename: path,
      status: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

/**
 * Merge a pull request into its base branch. `method` is 'merge' (a two-parent merge commit),
 * 'squash' (one commit, the pull's title) or 'rebase' (the head's commits replayed). Returns the
 * merge commit id, or null when the merge conflicts.
 */
export function mergePull(repo: RepoRec, pull: PullRec, method: string): string | null {
  const store = repo.objects;
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return null;
  const headCommit = peelToCommit(store, headTip);
  const baseCommit = peelToCommit(store, baseTip);
  if (headCommit === null || baseCommit === null) return null;
  const outcome = mergeTrees(repo, baseCommit, headCommit);
  if (outcome.conflicts.length > 0) return null;
  const baseRef = `refs/heads/${pull.baseRef}`;
  let mergeOid: string;
  if (method === 'rebase') {
    const replay = commitsSince(store, headCommit, baseCommit).reverse();
    let parent = baseCommit;
    let tree = parseCommit((store.get(baseCommit) as { data: Buffer }).data).tree;
    for (const commit of replay) {
      const info = parseCommit((store.get(commit) as { data: Buffer }).data);
      tree = info.tree === tree ? tree : rebaseTree(repo, parent, commit);
      parent = store.put('commit', buildCommit({ tree, parents: [parent], author: info.author, committer: FORGE_IDENT, message: info.message }));
    }
    if (replay.length === 0) {
      mergeOid = store.put('commit', buildCommit({ tree: outcome.tree, parents: [baseCommit], author: FORGE_IDENT, committer: FORGE_IDENT, message: pull.title }));
    } else {
      // The replay's final tree must equal the merged tree; rebuild the tip if the walk diverged.
      const tipInfo = parseCommit((store.get(parent) as { data: Buffer }).data);
      mergeOid = tipInfo.tree === outcome.tree
        ? parent
        : store.put('commit', buildCommit({ tree: outcome.tree, parents: tipInfo.parents, author: tipInfo.author, committer: FORGE_IDENT, message: tipInfo.message }));
    }
  } else if (method === 'merge') {
    mergeOid = store.put('commit', buildCommit({
      tree: outcome.tree,
      parents: [baseCommit, headCommit],
      author: FORGE_IDENT,
      committer: FORGE_IDENT,
      message: `Merge pull request #${pull.number} from ${pull.headRef}`,
    }));
  } else {
    mergeOid = store.put('commit', buildCommit({
      tree: outcome.tree,
      parents: [baseCommit],
      author: FORGE_IDENT,
      committer: FORGE_IDENT,
      message: `${pull.title} (#${pull.number})`,
    }));
  }
  repo.refs.set(baseRef, mergeOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = mergeOid;
  pull.mergedAt = NOW_ISO;
  return mergeOid;
}

/** The tree a single commit's change produces when replayed onto `ontoCommit` (for rebase merges). */
function rebaseTree(repo: RepoRec, ontoCommit: string, commit: string): string {
  const store = repo.objects;
  const info = parseCommit((store.get(commit) as { data: Buffer }).data);
  const parent = info.parents[0];
  if (parent === undefined) return info.tree;
  const outcome = mergeTrees(repo, ontoCommit, commit);
  return outcome.tree;
}
