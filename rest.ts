// The REST v3 surface: the API root and meta, the token's user, repository CRUD, branches, commits,
// the Git Data refs route, the contents API, labels, issues with comments, and pull requests with
// merges. Every reply is JSON; errors are {"message": ...}; the app adds the X-GitHub-Request-Id
// header. Only the routes the suite exercises are implemented — an unknown route is a JSON 404.

import { parseCommit, parseTree, peelToCommit } from './gitcore.ts';
import {
  NOW_ISO,
  OWNER_ID,
  OWNER_LOGIN,
  blobAtCommit,
  branchTip,
  commitChanges,
  forge,
  headRef,
  listAtCommit,
  mergePull,
  pullFiles,
  resolveCommitish,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Decoded path segments after /api/v3 (empty for the root). */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body, when the body was valid JSON (an object, usually). */
  body: Record<string, unknown> | undefined;
  /** True when a body was sent but did not parse as JSON. */
  bodyMalformed: boolean;
  /** The request's Host header, for building absolute pagination links. */
  host: string;
  authed: boolean;
}

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestReply => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string): RestReply => ({ status: 422, body: { message } });

// -------------------------------------------------------------------------------------------------
// Serializers

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: OWNER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    pushed_at: NOW_ISO,
    html_url: `http://localhost/${repo.owner}/${repo.name}`,
    url: `http://localhost/api/v3/repos/${repo.owner}/${repo.name}`,
    git_url: `http://localhost/${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000', description: null };
    }),
    user: { login: repo.owner, id: OWNER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    closed_at: issue.state === 'closed' ? NOW_ISO : null,
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate;
  return {
    id: repo.id * 100000 + pull.number,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${repo.owner}:${pull.headRef}`,
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: repo.owner, id: OWNER_ID, type: 'User' },
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    closed_at: pull.state === 'closed' ? NOW_ISO : null,
    draft: false,
  };
}

function identJson(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(ident.trim());
  if (match === null) return { name: ident, email: '', date: NOW_ISO };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

export function commitJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const info = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  return {
    sha: oid,
    commit: {
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? '' },
      author: identJson(info?.author ?? ''),
      committer: identJson(info?.committer ?? ''),
    },
    author: { login: OWNER_LOGIN },
    committer: { login: OWNER_LOGIN },
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

// -------------------------------------------------------------------------------------------------
// Pagination

function paginate<T>(req: RestRequest, path: string, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const perPageRaw = Number(req.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.trunc(perPageRaw), 100) : 30;
  const pageRaw = Number(req.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const last = Math.ceil(items.length / perPage);
    const base = `http://${req.host}${path}`;
    headers.link = `<${base}?page=${page + 1}&per_page=${perPage}>; rel="next", <${base}?page=${last}&per_page=${perPage}>; rel="last"`;
  }
  return { page: slice, headers };
}

// -------------------------------------------------------------------------------------------------
// Route handlers

function createRepo(req: RestRequest): RestReply {
  if (req.bodyMalformed) return { status: 400, body: { message: 'Problems parsing JSON' } };
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  if (name === '') return unprocessable('Repository creation failed: name is required');
  const repo = forge.createRepo(OWNER_LOGIN, name, {
    private: req.body?.private === true,
    description: typeof req.body?.description === 'string' ? req.body.description : '',
  });
  if (repo === null) {
    return {
      status: 422,
      body: {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      },
    };
  }
  return { status: 201, body: repoJson(repo) };
}

function contentsGet(req: RestRequest, repo: RepoRec, path: string): RestReply {
  const commit = resolveCommitish(repo, req.query.get('ref') ?? req.query.get('sha'));
  if (commit === null) return notFound();
  const blob = blobAtCommit(repo, commit, path);
  if (blob !== null) {
    const name = path.split('/').pop() as string;
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        name,
        path,
        sha: blob.oid,
        size: blob.data.length,
        content: blob.data.toString('base64'),
      },
    };
  }
  const listing = listAtCommit(repo, commit, path);
  if (listing === null) return notFound();
  return {
    status: 200,
    body: listing.map((entry) => ({
      type: entry.type,
      name: entry.name,
      path: entry.path,
      sha: entry.oid,
      size: 0,
    })),
  };
}

function contentsPut(req: RestRequest, repo: RepoRec, path: string): RestReply {
  if (req.bodyMalformed) return { status: 400, body: { message: 'Problems parsing JSON' } };
  const body = req.body ?? {};
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  const message = typeof body.message === 'string' ? body.message : 'update';
  const branchParam = typeof body.branch === 'string' && body.branch !== '' ? body.branch : null;
  const branch = branchParam ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  // A contents write on a branch that does not exist yet creates it (from the default branch's tip,
  // or as a root commit on an unborn repository): the MCP suite's setup relies on this route when
  // the Git Data refs route is unavailable, and it is harmless where the branch already exists.
  const creatingBranch = tip === null && branch !== repo.defaultBranch;
  const effectiveParent = tip ?? (creatingBranch ? branchTip(repo, repo.defaultBranch) : null);
  const commitForRead = effectiveParent === null ? null : peelToCommit(repo.objects, effectiveParent);
  const existing = commitForRead === null ? null : blobAtCommit(repo, commitForRead, path);
  const shaParam = typeof body.sha === 'string' ? body.sha : null;
  if (existing !== null) {
    if (shaParam === null) return unprocessable('sha is required to update an existing file');
    if (shaParam.toLowerCase() !== existing.oid.toLowerCase()) {
      return { status: 409, body: { message: `${path} has changed since ${shaParam}` } };
    }
  }
  const data = Buffer.from(contentB64, 'base64');
  let commitSha: string;
  if (creatingBranch && effectiveParent !== null) {
    // New branch from the default tip: seed it with the default tip first, then commit on top.
    repo.refs.set(`refs/heads/${branch}`, effectiveParent);
    commitSha = commitChanges(repo, branch, new Map([[path, data]]), message);
  } else {
    commitSha = commitChanges(repo, branch, new Map([[path, data]]), message);
  }
  const blobOid = blobAtCommit(repo, peelToCommit(repo.objects, commitSha) as string, path)?.oid ?? '';
  return {
    status: existing !== null ? 200 : 201,
    body: {
      content: {
        type: 'file',
        encoding: 'base64',
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: data.length,
      },
      commit: { sha: commitSha, message },
    },
  };
}

function contentsDelete(req: RestRequest, repo: RepoRec, path: string): RestReply {
  if (req.bodyMalformed) return { status: 400, body: { message: 'Problems parsing JSON' } };
  const body = req.body ?? {};
  const message = typeof body.message === 'string' ? body.message : 'delete';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (tip === null) return notFound();
  const commit = peelToCommit(repo.objects, tip);
  const existing = commit === null ? null : blobAtCommit(repo, commit, path);
  if (existing === null) return notFound();
  const shaParam = typeof body.sha === 'string' ? body.sha : null;
  if (shaParam !== null && shaParam.toLowerCase() !== existing.oid.toLowerCase()) {
    return { status: 409, body: { message: `${path} has changed since ${shaParam}` } };
  }
  const commitSha = commitChanges(repo, branch, new Map([[path, null]]), message);
  return { status: 200, body: { content: null, commit: { sha: commitSha, message } } };
}

function repoRoutes(req: RestRequest, owner: string, name: string, rest: string[]): RestReply {
  const repo = forge.getRepo(owner, name);
  const method = req.method;

  if (rest.length === 0) {
    if (repo === undefined) return notFound();
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      if (req.bodyMalformed) return { status: 400, body: { message: 'Problems parsing JSON' } };
      if (typeof req.body?.description === 'string') repo.description = req.body.description;
      if (typeof req.body?.private === 'boolean') repo.private = req.body.private;
      if (typeof req.body?.default_branch === 'string' && req.body.default_branch !== '') repo.defaultBranch = req.body.default_branch;
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return { status: 204 };
    }
    return notFound();
  }
  if (repo === undefined) return notFound();

  const [head, ...tail] = rest as [string, ...string[]];

  if (head === 'branches') {
    if (tail.length === 0 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, body: branches };
    }
    if (tail.length >= 1 && method === 'GET') {
      const branch = tail.join('/');
      const tip = branchTip(repo, branch);
      if (tip === null) return notFound();
      return { status: 200, body: { name: branch, commit: { sha: tip }, protected: false } };
    }
    return notFound();
  }

  if (head === 'commits' && tail.length === 0 && method === 'GET') {
    const start = resolveCommitish(repo, req.query.get('sha'));
    if (start === null) return { status: 200, body: [] };
    const seen = new Map<string, number>();
    let frontier = [start];
    seen.set(start, 0);
    let generation = 0;
    while (frontier.length > 0) {
      generation += 1;
      const next: string[] = [];
      for (const oid of frontier) {
        const object = repo.objects.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) {
          if (!seen.has(parent)) {
            seen.set(parent, generation);
            next.push(parent);
          }
        }
      }
      frontier = next;
    }
    const ordered = [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([oid]) => commitJson(repo, oid));
    return { status: 200, body: ordered };
  }

  if (head === 'git' && tail[0] === 'refs') {
    if (tail.length === 1 && method === 'POST') {
      if (req.bodyMalformed) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const ref = typeof req.body?.ref === 'string' ? req.body.ref : '';
      const sha = typeof req.body?.sha === 'string' ? req.body.sha.toLowerCase() : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return unprocessable('Invalid ref or sha');
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      repo.refs.set(ref, sha);
      const object = repo.objects.get(sha);
      return { status: 201, body: { ref, object: { sha, type: object?.type ?? 'commit' } } };
    }
    if (tail.length >= 2 && method === 'GET') {
      const ref = `refs/${tail.slice(1).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return notFound();
      const object = repo.objects.get(oid);
      return { status: 200, body: { ref, object: { sha: oid, type: object?.type ?? 'commit' } } };
    }
    return notFound();
  }

  if (head === 'contents') {
    const path = tail.join('/');
    if (method === 'GET') return contentsGet(req, repo, path);
    if (method === 'PUT') return contentsPut(req, repo, path);
    if (method === 'DELETE') return contentsDelete(req, repo, path);
    return notFound();
  }

  if (head === 'labels') {
    if (tail.length === 0 && method === 'GET') {
      return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: null, default: false })) };
    }
    if (tail.length === 0 && method === 'POST') {
      if (req.bodyMalformed) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const labelName = typeof req.body?.name === 'string' ? req.body.name : '';
      const color = typeof req.body?.color === 'string' ? req.body.color.replace(/^#/, '') : '000000';
      if (labelName === '') return unprocessable('Label name is required');
      if (repo.labels.has(labelName)) return unprocessable('Label already exists');
      repo.labels.set(labelName, { name: labelName, color });
      return { status: 201, body: { name: labelName, color, description: null, default: false } };
    }
    return notFound();
  }

  if (head === 'issues') {
    if (tail.length === 0 && method === 'POST') {
      if (req.bodyMalformed) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const title = typeof req.body?.title === 'string' ? req.body.title : '';
      if (title === '') return unprocessable('Title is required');
      const labels = Array.isArray(req.body?.labels) ? (req.body.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return unprocessable(`Validation Failed: label "${label}" does not exist`);
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        number,
        title,
        body: typeof req.body?.body === 'string' ? req.body.body : '',
        state: 'open',
        labels,
        comments: [],
        seq: forge.nextSeq(),
      };
      repo.issues.set(number, issue);
      return { status: 201, body: issueJson(repo, issue) };
    }
    if (tail.length === 0 && method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      const direction = req.query.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page, headers } = paginate(req, `/api/v3/repos/${owner}/${name}/issues`, list);
      return { status: 200, body: page.map((issue) => issueJson(repo, issue)), headers };
    }
    const number = Number(tail[0]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (tail.length === 1) {
      if (issue === undefined) return notFound();
      if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
      if (method === 'PATCH') {
        if (req.bodyMalformed) return { status: 400, body: { message: 'Problems parsing JSON' } };
        if (req.body?.state === 'closed' || req.body?.state === 'open') issue.state = req.body.state;
        if (typeof req.body?.title === 'string') issue.title = req.body.title;
        if (typeof req.body?.body === 'string') issue.body = req.body.body;
        if (Array.isArray(req.body?.labels)) {
          const labels = (req.body.labels as unknown[]).filter((x): x is string => typeof x === 'string');
          for (const label of labels) if (!repo.labels.has(label)) return unprocessable(`Validation Failed: label "${label}" does not exist`);
          issue.labels = labels;
        }
        return { status: 200, body: issueJson(repo, issue) };
      }
      return notFound();
    }
    if (tail.length === 2 && tail[1] === 'comments') {
      if (issue === undefined) return notFound();
      if (method === 'GET') {
        return {
          status: 200,
          body: issue.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: repo.owner, id: OWNER_ID, type: 'User' },
            created_at: NOW_ISO,
            updated_at: NOW_ISO,
          })),
        };
      }
      if (method === 'POST') {
        if (req.bodyMalformed) return { status: 400, body: { message: 'Problems parsing JSON' } };
        const text = typeof req.body?.body === 'string' ? req.body.body : '';
        const comment = { id: repo.nextCommentId, body: text };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        return {
          status: 201,
          body: { id: comment.id, body: comment.body, user: { login: repo.owner, id: OWNER_ID, type: 'User' }, created_at: NOW_ISO, updated_at: NOW_ISO },
        };
      }
      return notFound();
    }
    return notFound();
  }

  if (head === 'pulls') {
    if (tail.length === 0 && method === 'POST') {
      if (req.bodyMalformed) return { status: 400, body: { message: 'Problems parsing JSON' } };
      const title = typeof req.body?.title === 'string' ? req.body.title : '';
      const stripPrefix = (value: unknown): string => {
        const text = typeof value === 'string' ? value : '';
        const colon = text.indexOf(':');
        return colon === -1 ? text : text.slice(colon + 1);
      };
      const headBranch = stripPrefix(req.body?.head);
      const baseBranch = stripPrefix(req.body?.base);
      const headSha = branchTip(repo, headBranch);
      const baseSha = branchTip(repo, baseBranch);
      if (headSha === null || baseSha === null) return unprocessable('Validation Failed: head or base branch does not exist');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === headBranch && existing.baseRef === baseBranch) {
          return unprocessable('Validation Failed: a pull request already exists for this branch combination');
        }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        number,
        title,
        body: typeof req.body?.body === 'string' ? req.body.body : '',
        state: 'open',
        merged: false,
        headRef: headBranch,
        baseRef: baseBranch,
        headShaAtCreate: headSha,
        baseShaAtCreate: baseSha,
        mergeCommitSha: null,
        mergedAt: null,
        seq: forge.nextSeq(),
      };
      repo.pulls.set(number, pull);
      return { status: 201, body: pullJson(repo, pull) };
    }
    if (tail.length === 0 && method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => b.seq - a.seq);
      const { page, headers } = paginate(req, `/api/v3/repos/${owner}/${name}/pulls`, list);
      return { status: 200, body: page.map((pull) => pullJson(repo, pull)), headers };
    }
    const number = Number(tail[0]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (tail.length === 1 && method === 'GET') {
      if (pull === undefined) return notFound();
      return { status: 200, body: pullJson(repo, pull) };
    }
    if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
      if (pull === undefined) return notFound();
      return { status: 200, body: pullFiles(repo, pull) };
    }
    if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
      if (pull === undefined) return notFound();
      if (pull.merged || pull.state !== 'open') return { status: 405, body: { message: 'Pull Request is not mergeable' } };
      const method2 = typeof req.body?.merge_method === 'string' ? req.body.merge_method : 'merge';
      const sha = mergePull(repo, pull, method2);
      if (sha === null) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
      return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    return notFound();
  }

  return notFound();
}

/** Handle one REST request (the segments after /api/v3). Always answers; never throws. */
export function handleRest(req: RestRequest): RestReply {
  const segments = req.segments;
  if (segments.length === 0) {
    if (req.method === 'GET') {
      return {
        status: 200,
        headers: { 'x-oauth-scopes': 'repo, read:org, write:org' },
        body: {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
          emojis_url: '/api/v3/emojis',
        },
      };
    }
    return notFound();
  }
  if (segments[0] === 'meta' && segments.length === 1 && req.method === 'GET') {
    return {
      status: 200,
      body: {
        installed_version: '3.13.0-forge',
        github_auth_mode: 'token',
        verifiable_password_authentication: false,
      },
    };
  }
  // Everything below needs the token.
  if (!req.authed) return { status: 401, body: { message: 'Requires authentication' } };
  if (segments[0] === 'user') {
    if (segments.length === 1 && req.method === 'GET') {
      return { status: 200, body: { login: OWNER_LOGIN, id: OWNER_ID, type: 'User', name: OWNER_LOGIN } };
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (req.method === 'POST') return createRepo(req);
      if (req.method === 'GET') {
        const { page, headers } = paginate(req, '/api/v3/user/repos', forge.reposOf(OWNER_LOGIN));
        return { status: 200, body: page.map((repo) => repoJson(repo)), headers };
      }
    }
    return notFound();
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    return repoRoutes(req, segments[1] as string, segments[2] as string, segments.slice(3));
  }
  return notFound();
}
