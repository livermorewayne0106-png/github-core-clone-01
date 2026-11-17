// The MCP endpoint at /mcp: JSON-RPC 2.0 over streamable HTTP, answering plain JSON. Both protocol
// eras the suite accepts are served: the 2026-07-28 revision's server/discover (identity,
// capabilities and supported versions in one answer, no handshake) and the legacy initialize +
// notifications/initialized handshake. The six GitHub tools share the forge's one store with REST
// and GraphQL, so an object created over MCP reads back over /api/v3 unchanged.

import { OWNER_LOGIN, branchTip, forge, mergePull, type RepoRec } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

/** The tools/list answer: built once, so repeated calls are byte-for-byte identical. */
const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  })),
};

export interface McpReply {
  status: number;
  body?: unknown;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolSuccess(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function findRepo(args: Record<string, unknown>): RepoRec | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  return forge.getRepo(owner, name) ?? null;
}

function callTool(name: string, args: Record<string, unknown>): McpReply['body'] {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return null; // handled by the caller as an unknown-tool error
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { __error: -32602, message: `missing required argument: ${required}` };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repo = forge.createRepo(OWNER_LOGIN, String(args.name), {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (repo === null) return toolFailure(`a repository named ${String(args.name)} already exists`);
      return toolSuccess(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(args);
      if (repo === null) return toolFailure('repository not found');
      return toolSuccess(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo(args);
      if (repo === null) return toolFailure('repository not found');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue = {
        number,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        comments: [],
        seq: forge.nextSeq(),
      };
      repo.issues.set(number, issue);
      return toolSuccess(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(args);
      if (repo === null) return toolFailure('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => a.seq - b.seq);
      return toolSuccess(list.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = findRepo(args);
      if (repo === null) return toolFailure('repository not found');
      const head = String(args.head);
      const base = String(args.base);
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === null || baseSha === null) return toolFailure('head or base branch does not exist');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull = {
        number,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        merged: false,
        headRef: head,
        baseRef: base,
        headShaAtCreate: headSha,
        baseShaAtCreate: baseSha,
        mergeCommitSha: null,
        mergedAt: null,
        seq: forge.nextSeq(),
      };
      repo.pulls.set(number, pull);
      return toolSuccess(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo(args);
      if (repo === null) return toolFailure('repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolFailure('pull request not found');
      if (pull.merged || pull.state !== 'open') return toolFailure('pull request is not mergeable');
      const sha = mergePull(repo, pull, 'squash');
      if (sha === null) return toolFailure('pull request is not mergeable');
      return toolSuccess(pullJson(repo, pull));
    }
  }
  return toolFailure('unsupported tool');
}

/** Handle one MCP HTTP request. `rawBody` is the unparsed body (parse errors are scored). */
export function handleMcp(rawBody: Buffer, authed: boolean): McpReply {
  if (!authed) return { status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const handleOne = (message: Record<string, unknown>): McpReply => {
    const id = message.id;
    const method = typeof message.method === 'string' ? message.method : '';
    if (id === undefined) return { status: 202 }; // a notification: accepted, no answer
    switch (method) {
      case 'server/discover':
        return rpcResult(id, {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        });
      case 'initialize': {
        const params = (message.params ?? {}) as Record<string, unknown>;
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, TOOLS_LIST_RESULT);
      case 'tools/call': {
        const params = (message.params ?? {}) as Record<string, unknown>;
        const toolName = typeof params.name === 'string' ? params.name : '';
        const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        const result = callTool(toolName, args);
        if (result === null) return rpcError(id, -32602, `unknown tool: ${toolName}`);
        if (typeof result === 'object' && result !== null && '__error' in result) {
          const failure = result as unknown as { __error: number; message: string };
          return rpcError(id, failure.__error, failure.message);
        }
        return rpcResult(id, result);
      }
      default:
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  };
  if (Array.isArray(parsed)) {
    const replies = parsed
      .map((entry) => handleOne(entry as Record<string, unknown>))
      .filter((reply) => reply.status !== 202);
    if (replies.length === 0) return { status: 202 };
    return { status: 200, body: replies.map((reply) => reply.body) };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  return handleOne(parsed as Record<string, unknown>);
}
