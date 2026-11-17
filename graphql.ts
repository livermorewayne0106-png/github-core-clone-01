// The GraphQL v4 surface: a small parser and executor for the documents gh and github-mcp-server
// send — viewer and repository reads, issue and pull-request connections with cursor pagination,
// the create/close/merge/comment mutations, Relay node(id:) lookups, batched operations, and the
// __type introspection probes. Unknown fields answer HTTP 200 with an errors array naming them;
// an unknown repository answers data.repository = null with no errors.

import { branchTip, forge, mergeConflicts, mergePull, pullFiles, type IssueRec, type PullRec, type RepoRec } from './store.ts';

// -------------------------------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, and never the plain database id.

function globalId(kind: string, key: string | number): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon === -1) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoByGlobalId(id: string): RepoRec | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const dbId = Number(decoded.key);
  for (const repo of forge.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function issueByGlobalId(id: string): { repo: RepoRec; issue: IssueRec } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const [repoId, number] = decoded.key.split(':').map(Number);
  for (const repo of forge.repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.get(number as number);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function pullByGlobalId(id: string): { repo: RepoRec; pull: PullRec } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const [repoId, number] = decoded.key.split(':').map(Number);
  for (const repo of forge.repos.values()) {
    if (repo.id !== repoId) continue;
    const pull = repo.pulls.get(number as number);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// Lexer and parser for the GraphQL subset the suite sends.

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Map<string, Value>;
  selection: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  type: 'query' | 'mutation';
  selection: SelectionNode[];
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:$!'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push(`"${value}`);
      i = j + 1;
      continue;
    }
    const match = /^[A-Za-z0-9_-]+/.exec(input.slice(i));
    if (match !== null) {
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: string[]) {}

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private take(): string {
    const token = this.tokens[this.pos] as string;
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    if (this.take() !== token) throw new Error(`expected ${token}`);
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        const type = this.take() as 'query' | 'mutation';
        if (this.peek() !== '(' && this.peek() !== '{') this.take(); // operation name
        if (this.peek() === '(') this.skipBalanced(); // variable definitions
        operations.push({ type, selection: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        // Named fragments are not sent by the suite; skip the definition if one appears.
        this.take();
        this.take();
        this.take();
        this.take();
        this.parseSelectionSet();
      } else {
        this.take();
      }
    }
    return operations;
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const token = this.take();
      if (token === '(' || token === '[' || token === '{') depth += 1;
      else if (token === ')' || token === ']' || token === '}') depth -= 1;
    } while (depth > 0 && this.pos < this.tokens.length);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const nodes: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.take();
        let typeCondition: string | null = null;
        if (this.peek() === 'on') {
          this.take();
          typeCondition = this.take();
        }
        nodes.push({ kind: 'fragment', typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      let name = this.take();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.take();
        alias = name;
        name = this.take();
      }
      const args = new Map<string, Value>();
      if (this.peek() === '(') {
        this.take();
        while (this.peek() !== ')') {
          const argName = this.take();
          this.expect(':');
          args.set(argName, this.parseValue());
        }
        this.take();
      }
      const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
      nodes.push({ kind: 'field', name, alias, args, selection });
    }
    this.take();
    return nodes;
  }

  private parseValue(): Value {
    const token = this.take();
    if (token === '$') return { kind: 'var', name: this.take() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1) };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.take();
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const key = this.take();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.take();
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Schema description for the introspection probes.

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'createdAt', 'updatedAt', 'author', 'mergedAt', 'url',
  ],
  User: ['id', 'login', 'name', 'email'],
  Ref: ['name', 'target'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// -------------------------------------------------------------------------------------------------
// Execution

type GqlObject = { __type: string; [key: string]: unknown };

interface ExecContext {
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function cursorOf(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function seqOfCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function issueConnection(repo: RepoRec, args: Map<string, Value>, ctx: ExecContext): GqlObject {
  let list = [...repo.issues.values()];
  const states = args.has('states') ? (resolveValue(args.get('states') as Value, ctx.variables) as unknown[]) : null;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = states.map((state) => String(state).toLowerCase());
    list = list.filter((issue) => wanted.includes(issue.state));
  }
  let descending = false;
  if (args.has('orderBy')) {
    const orderBy = resolveValue(args.get('orderBy') as Value, ctx.variables) as Record<string, unknown> | null;
    if (orderBy !== null && typeof orderBy === 'object' && orderBy.direction === 'DESC') descending = true;
  }
  list.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
  const after = args.has('after') ? (resolveValue(args.get('after') as Value, ctx.variables) as string | null) : null;
  if (after !== null && after !== undefined) {
    const seq = seqOfCursor(after);
    if (seq !== null) list = list.filter((issue) => (descending ? issue.seq < seq : issue.seq > seq));
  }
  const first = args.has('first') ? Number(resolveValue(args.get('first') as Value, ctx.variables)) : list.length;
  const page = list.slice(0, Math.max(0, first));
  const last = page[page.length - 1];
  return {
    __type: 'IssueConnection',
    nodes: page.map((issue) => ({ __type: 'Issue', repo, issue })),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: list.length > page.length,
      endCursor: last === undefined ? null : cursorOf(last.seq),
    },
  };
}

function pullMergeable(repo: RepoRec, pull: PullRec): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const head = branchTip(repo, pull.headRef);
  const base = branchTip(repo, pull.baseRef);
  if (head === null || base === null) return 'UNKNOWN';
  return mergeConflicts(repo, base, head) ? 'CONFLICTING' : 'MERGEABLE';
}

function resolveField(type: string, source: GqlObject | null, field: FieldNode, ctx: ExecContext): unknown {
  const name = field.name;
  const arg = (key: string): unknown => (field.args.has(key) ? resolveValue(field.args.get(key) as Value, ctx.variables) : undefined);
  switch (type) {
    case 'Query': {
      if (name === 'viewer') return { __type: 'User', login: source?.login ?? undefined } satisfies GqlObject;
      if (name === 'repository') {
        const repo = forge.getRepo(String(arg('owner')), String(arg('name')));
        return repo === undefined ? null : ({ __type: 'Repository', repo } satisfies GqlObject);
      }
      if (name === 'node') {
        const id = String(arg('id'));
        const repo = repoByGlobalId(id);
        if (repo !== null) return { __type: 'Repository', repo } satisfies GqlObject;
        const foundIssue = issueByGlobalId(id);
        if (foundIssue !== null) return { __type: 'Issue', repo: foundIssue.repo, issue: foundIssue.issue } satisfies GqlObject;
        const foundPull = pullByGlobalId(id);
        if (foundPull !== null) return { __type: 'PullRequest', repo: foundPull.repo, pull: foundPull.pull } satisfies GqlObject;
        return null;
      }
      if (name === '__type') {
        const typeName = String(arg('name'));
        if (TYPE_FIELDS[typeName] === undefined && ENUM_VALUES[typeName] === undefined) return null;
        return { __type: '__Type', typeName } satisfies GqlObject;
      }
      if (name === '__schema') return { __type: '__Schema' } satisfies GqlObject;
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (arg('input') ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(String(input.repositoryId));
        if (repo === null) throw new Error('repository not found');
        const number = repo.nextNumber;
        repo.nextNumber += 1;
        const issue: IssueRec = {
          number,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          state: 'open',
          labels: [],
          comments: [],
          seq: forge.nextSeq(),
        };
        repo.issues.set(number, issue);
        return { __type: 'CreateIssuePayload', repo, issue } satisfies GqlObject;
      }
      if (name === 'closeIssue') {
        const input = (arg('input') ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(String(input.issueId));
        if (found === null) throw new Error('issue not found');
        found.issue.state = 'closed';
        return { __type: 'CloseIssuePayload', repo: found.repo, issue: found.issue } satisfies GqlObject;
      }
      if (name === 'createPullRequest') {
        const input = (arg('input') ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(String(input.repositoryId));
        if (repo === null) throw new Error('repository not found');
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        const headSha = branchTip(repo, headRef);
        const baseSha = branchTip(repo, baseRef);
        if (headSha === null || baseSha === null) throw new Error('head or base branch does not exist');
        const number = repo.nextNumber;
        repo.nextNumber += 1;
        const pull: PullRec = {
          number,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          state: 'open',
          merged: false,
          headRef,
          baseRef,
          headShaAtCreate: headSha,
          baseShaAtCreate: baseSha,
          mergeCommitSha: null,
          mergedAt: null,
          seq: forge.nextSeq(),
        };
        repo.pulls.set(number, pull);
        return { __type: 'CreatePullRequestPayload', repo, pull } satisfies GqlObject;
      }
      if (name === 'mergePullRequest') {
        const input = (arg('input') ?? {}) as Record<string, unknown>;
        const found = pullByGlobalId(String(input.pullRequestId));
        if (found === null) throw new Error('pull request not found');
        const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
        const sha = mergePull(found.repo, found.pull, method);
        if (sha === null) throw new Error('pull request is not mergeable');
        return { __type: 'MergePullRequestPayload', repo: found.repo, pull: found.pull } satisfies GqlObject;
      }
      if (name === 'addComment') {
        const input = (arg('input') ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(String(input.subjectId));
        if (found === null) throw new Error('subject not found');
        const comment = { id: found.repo.nextCommentId, body: String(input.body ?? '') };
        found.repo.nextCommentId += 1;
        found.issue.comments.push(comment);
        return { __type: 'AddCommentPayload', repo: found.repo, comment } satisfies GqlObject;
      }
      break;
    }
    case 'User': {
      if (name === 'login') return (source?.login as string | undefined) ?? 'adaiversen';
      if (name === 'id') return globalId('User', 1000);
      if (name === 'name') return 'ada iversen';
      break;
    }
    case 'Repository': {
      const repo = source?.repo as RepoRec;
      switch (name) {
        case 'id': return globalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { __type: 'User', login: repo.owner } satisfies GqlObject;
        case 'defaultBranchRef': {
          const tip = branchTip(repo, repo.defaultBranch);
          return tip === null ? null : ({ __type: 'Ref', name: repo.defaultBranch } satisfies GqlObject);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'isPrivate': return repo.private;
        case 'issue': {
          const issue = repo.issues.get(Number(arg('number')));
          return issue === undefined ? null : ({ __type: 'Issue', repo, issue } satisfies GqlObject);
        }
        case 'issues': return issueConnection(repo, field.args, ctx);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(arg('number')));
          return pull === undefined ? null : ({ __type: 'PullRequest', repo, pull } satisfies GqlObject);
        }
        case 'pullRequests': {
          const first = field.args.has('first') ? Number(arg('first')) : undefined;
          const list = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
          const page = first === undefined ? list : list.slice(0, Math.max(0, first));
          return {
            __type: 'PullRequestConnection',
            nodes: page.map((pull) => ({ __type: 'PullRequest', repo, pull })),
          } satisfies GqlObject;
        }
      }
      break;
    }
    case 'Issue': {
      const repo = source?.repo as RepoRec;
      const issue = source?.issue as IssueRec;
      switch (name) {
        case 'id': return globalId('Issue', `${repo.id}:${issue.number}`);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
      }
      break;
    }
    case 'PullRequest': {
      const repo = source?.repo as RepoRec;
      const pull = source?.pull as PullRec;
      switch (name) {
        case 'id': return globalId('PullRequest', `${repo.id}:${pull.number}`);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return pullMergeable(repo, pull);
        case 'files': {
          const first = field.args.has('first') ? Number(arg('first')) : 100;
          return {
            __type: 'PullRequestFileConnection',
            nodes: pullFiles(repo, pull).slice(0, Math.max(0, first)).map((file) => ({ __type: 'PullRequestChangedFile', path: file.filename })),
          } satisfies GqlObject;
        }
      }
      break;
    }
    case 'Ref': {
      if (name === 'name') return source?.name;
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection': {
      if (name === 'nodes') return source?.nodes;
      if (name === 'pageInfo') return source?.pageInfo;
      if (name === 'totalCount') return (source?.nodes as unknown[] | undefined)?.length ?? 0;
      break;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return source?.hasNextPage;
      if (name === 'endCursor') return source?.endCursor;
      if (name === 'hasPreviousPage') return false;
      if (name === 'startCursor') return source?.endCursor;
      break;
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return source?.path;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return { __type: 'Issue', repo: source?.repo, issue: source?.issue } satisfies GqlObject;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return { __type: 'PullRequest', repo: source?.repo, pull: source?.pull } satisfies GqlObject;
      break;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return { __type: 'CommentEdge', repo: source?.repo, comment: source?.comment } satisfies GqlObject;
      break;
    }
    case 'CommentEdge': {
      if (name === 'node') {
        const repo = source?.repo as RepoRec;
        const comment = source?.comment as { id: number; body: string };
        return { __type: 'IssueComment', id: globalId('IssueComment', `${repo.id}:${comment.id}`), body: comment.body } satisfies GqlObject;
      }
      break;
    }
    case 'IssueComment': {
      if (name === 'id') return source?.id;
      if (name === 'body') return source?.body;
      break;
    }
    case '__Type': {
      const typeName = source?.typeName as string;
      if (name === 'name') return typeName;
      if (name === 'fields') return (TYPE_FIELDS[typeName] ?? []).map((fieldName) => ({ __type: '__Field', name: fieldName }));
      if (name === 'enumValues') return (ENUM_VALUES[typeName] ?? []).map((valueName) => ({ __type: '__EnumValue', name: valueName }));
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (name === 'name') return source?.name;
      break;
    }
  }
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
  return null;
}

function executeSelection(type: string, source: GqlObject | null, selection: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'fragment') {
      if (node.typeCondition === null || node.typeCondition === type) {
        Object.assign(out, executeSelection(type, source, node.selection, ctx));
      }
      continue;
    }
    const key = node.alias ?? node.name;
    if (node.name === '__typename') {
      out[key] = type;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(type, source, node, ctx);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      value = null;
    }
    out[key] = completeValue(value, node, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (typeof value === 'object') {
    const object = value as GqlObject;
    if (typeof object.__type === 'string' && field.selection !== null) {
      return executeSelection(object.__type, object, field.selection, ctx);
    }
    return value;
  }
  return value;
}

export interface GraphQLReply {
  status: number;
  body: unknown;
}

/** Execute one GraphQL operation document ({query, variables, operationName}). */
export function executeGraphQL(document: { query?: unknown; variables?: unknown; operationName?: unknown }): GraphQLReply {
  if (typeof document.query !== 'string') {
    return { status: 400, body: { errors: [{ message: 'query is required' }] } };
  }
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(document.query)).parseDocument();
  } catch (error) {
    return { status: 400, body: { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] } };
  }
  if (operations.length === 0) {
    return { status: 400, body: { errors: [{ message: 'no operation found' }] } };
  }
  let operation = operations[0] as OperationNode;
  if (typeof document.operationName === 'string' && operations.length > 1) {
    operation = operations[0] as OperationNode;
  }
  const variables = (typeof document.variables === 'object' && document.variables !== null ? document.variables : {}) as Record<string, unknown>;
  const ctx: ExecContext = { variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(rootType, null, operation.selection, ctx);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return { status: 200, body };
}
