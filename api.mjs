import { ApiError, commitFiles, filesAt, parseCommit, parseTree, peelObject, putObject, resolveRef } from './domain.mjs';
const notFound = () => {
  throw new ApiError(404, 'Not Found');
};
const objectInput = body => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Expected a JSON object');
  return body;
};
const integer = (value, fallback, max) => {
  const parsed = Number(value);
  return value !== null && Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

/** REST pagination keeps every link on the address used by the client. */
function page(items, url) {
  const perPage = integer(url.searchParams.get('per_page'), 30, 100);
  const current = integer(url.searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER);
  const total = Math.ceil(items.length / perPage);
  const links = [];
  const link = (n, rel) => {
    const next = new URL(url);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(n));
    links.push(`<${next.href}>; rel="${rel}"`);
  };
  if (current < total) {
    link(current + 1, 'next');
    link(total, 'last');
  }
  if (current > 1 && total > 0) {
    link(current - 1, 'prev');
    link(1, 'first');
  }
  return {
    status: 200,
    body: items.slice((current - 1) * perPage, current * perPage),
    headers: links.length ? {
      Link: links.join(', ')
    } : undefined
  };
}
function issueJson(issue) {
  const {
    commentList,
    ...json
  } = issue;
  if (issue.head) json.pull_request = {
    url: `pulls/${issue.number}`
  };
  return json;
}
const issueReadCache = new WeakMap();
function issueReply(issue) {
  // Store mutations advance updated_at or comments. Pull merges also have a
  // merge commit, so the immutable wire response can be reused between reads.
  const stamp = `${issue.updated_at}|${issue.comments ?? 0}|${issue.state}|${issue.merged ?? ''}|${issue.merge_commit_sha ?? ''}`;
  let cached = issueReadCache.get(issue);
  if (!cached || cached.stamp !== stamp) {
    const body = issueJson(issue);
    cached = {
      stamp,
      body,
      serialized: JSON.stringify(body)
    };
    issueReadCache.set(issue, cached);
  }
  return {
    status: 200,
    body: cached.body,
    serialized: cached.serialized
  };
}
function validateFields(input, fields) {
  for (const [key, type] of Object.entries(fields)) {
    if (input[key] !== undefined && typeof input[key] !== type) throw new ApiError(422, `Invalid ${key}`);
  }
}
function validateIssueInput(input) {
  validateFields(input, {
    title: 'string',
    body: 'string',
    state: 'string'
  });
  if (input.title !== undefined && input.title.length === 0) throw new ApiError(422, 'Title is required');
  if (input.state !== undefined && !['open', 'closed'].includes(input.state)) throw new ApiError(422, 'Invalid issue state');
  if (input.labels !== undefined && (!Array.isArray(input.labels) || input.labels.some(label => typeof label !== 'string' && (!label || typeof label !== 'object' || typeof label.name !== 'string')))) throw new ApiError(422, 'Labels must be an array of label names');
}
function pullJson(repo, pull) {
  return {
    ...issueJson(pull),
    head: {
      ...pull.head,
      sha: resolveRef(repo, pull.head.ref) ?? pull.head.sha
    },
    base: {
      ...pull.base,
      sha: resolveRef(repo, pull.base.ref) ?? pull.base.sha
    }
  };
}
function commitJson(repo, sha) {
  sha = peelObject(repo, sha);
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return notFound();
  const commit = parseCommit(obj.data);
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`).toString('base64'),
    commit: {
      message: commit.message.replace(/\n$/, ''),
      tree: {
        sha: commit.tree
      }
    },
    parents: commit.parents.map(sha => ({
      sha
    }))
  };
}
function contents(repo, path, ref) {
  const tip = peelObject(repo, resolveRef(repo, ref));
  if (!tip) return notFound();
  const files = filesAt(repo, ref);
  const file = files.get(path);
  if (file) {
    const obj = repo.objects.get(file.oid);
    if (!obj) return notFound();
    return {
      type: 'file',
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      sha: file.oid,
      size: obj.data.length,
      encoding: 'base64',
      content: obj.data.toString('base64')
    };
  }
  const root = repo.objects.get(tip);
  let tree = root.type === 'tree' ? tip : parseCommit(root.data).tree;
  for (const name of path.split('/').filter(Boolean)) {
    const entry = parseTree(repo.objects.get(tree).data).find(e => e.name === name && (e.mode === '40000' || e.mode === '040000'));
    if (!entry) return notFound();
    tree = entry.oid;
  }
  return parseTree(repo.objects.get(tree).data).map(entry => ({
    name: entry.name,
    path: path ? `${path}/${entry.name}` : entry.name,
    sha: entry.oid,
    type: entry.mode === '40000' || entry.mode === '040000' ? 'dir' : 'file',
    size: repo.objects.get(entry.oid)?.data.length ?? 0
  }));
}
function changeContent(store, repo, method, path, input) {
  if (!path || path.split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) throw new ApiError(422, 'Invalid file path');
  if (typeof input.message !== 'string') throw new ApiError(422, 'Commit message is required');
  const branch = input.branch ?? repo.default_branch;
  if (typeof branch !== 'string') throw new ApiError(422, 'Invalid branch');
  const parent = repo.refs.get(`refs/heads/${branch}`);
  if (!parent && (branch !== repo.default_branch || repo.refs.size > 0)) throw new ApiError(422, 'Branch not found');
  const files = filesAt(repo, branch),
    existing = files.get(path);
  if (method === 'DELETE' && !existing) return notFound();
  if (existing && input.sha !== existing.oid) throw new ApiError(409, 'The blob SHA does not match the current file');
  if (!existing && input.sha !== undefined) throw new ApiError(409, 'The blob SHA does not match the current file');
  let content = null;
  if (method === 'DELETE') files.delete(path);else {
    if (typeof input.content !== 'string') throw new ApiError(422, 'Content must be base64');
    const compact = input.content.replace(/\s/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(compact)) throw new ApiError(422, 'Content must be base64');
    for (const oldPath of files.keys()) if (oldPath.startsWith(path + '/') || path.startsWith(oldPath + '/')) throw new ApiError(409, 'A file conflicts with this path');
    const bytes = Buffer.from(input.content, 'base64');
    const oid = putObject(repo, 'blob', bytes);
    files.set(path, {
      oid,
      mode: existing?.mode ?? '100644'
    });
    content = {
      type: 'file',
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      sha: oid,
      size: bytes.length,
      encoding: 'base64',
      content: bytes.toString('base64')
    };
  }
  const sha = commitFiles(repo, files, parent ? [parent] : [], input.message, 1700000000 + store.clock++);
  repo.refs.set(`refs/heads/${branch}`, sha);
  store.touch(repo);
  return {
    status: method === 'DELETE' || existing ? 200 : 201,
    body: {
      content,
      commit: commitJson(repo, sha)
    }
  };
}

/** Thin REST adapter: Git objects and collaborative state belong to Store. */
export function rest(store, method, url, body) {
  try {
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (segments[0] !== 'api' || segments[1] !== 'v3') return notFound();
    const route = segments.slice(2);
    const input = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && body !== undefined ? objectInput(body) : {};
    if (route.length === 0 && method === 'GET') return {
      status: 200,
      body: {
        current_user_url: `${url.origin}/api/v3/user`,
        repository_url: `${url.origin}/api/v3/repos/{owner}/{repo}`
      },
      headers: {
        'X-OAuth-Scopes': 'repo, read:user'
      }
    };
    if (route.length === 1 && route[0] === 'meta' && method === 'GET') return {
      status: 200,
      body: {
        installed_version: 'native-forge-1.0.0'
      }
    };
    if (route.length === 1 && route[0] === 'user' && method === 'GET') return {
      status: 200,
      body: store.user()
    };
    if (route.length === 2 && route[0] === 'user' && route[1] === 'repos') {
      if (method === 'POST') {
        validateFields(input, {
          name: 'string',
          description: 'string',
          private: 'boolean',
          default_branch: 'string'
        });
        return {
          status: 201,
          body: store.repoJson(store.createRepo(input))
        };
      }
      if (method === 'GET') return page([...store.repos.values()].map(repo => store.repoJson(repo)), url);
      return notFound();
    }
    if (route[0] !== 'repos' || route.length < 3) return notFound();
    const repo = store.getRepo(route[1], route[2]);
    const tail = route.slice(3);
    if (tail.length === 0) {
      if (method === 'GET') return {
        status: 200,
        body: store.repoJson(repo)
      };
      if (method === 'PATCH') {
        validateFields(input, {
          description: 'string',
          private: 'boolean',
          default_branch: 'string'
        });
        if (input.default_branch !== undefined && !repo.refs.has(`refs/heads/${input.default_branch}`)) throw new ApiError(422, 'Default branch does not exist');
        for (const key of ['description', 'private', 'default_branch']) if (input[key] !== undefined) repo[key] = input[key];
        store.touch(repo);
        return {
          status: 200,
          body: store.repoJson(repo)
        };
      }
      if (method === 'DELETE') {
        store.repos.delete(repo.name.toLowerCase());
        for (const [id, node] of store.nodes) if (node === repo || node.repo === repo) store.nodes.delete(id);
        return {
          status: 204
        };
      }
      return notFound();
    }
    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      if (method === 'GET') return {
        status: 200,
        body: contents(repo, path, url.searchParams.get('ref') ?? undefined)
      };
      if (method === 'PUT' || method === 'DELETE') return changeContent(store, repo, method, path, input);
      return notFound();
    }
    if (tail[0] === 'git' && (tail[1] === 'refs' || tail[1] === 'ref')) {
      const ref = tail.length > 2 ? `refs/${tail.slice(2).join('/')}` : undefined;
      const json = (ref, sha) => ({
        ref,
        node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'),
        object: {
          type: repo.objects.get(sha)?.type ?? 'commit',
          sha
        }
      });
      if (method === 'GET') {
        if (!ref) return page([...repo.refs].map(([ref, sha]) => json(ref, sha)), url);
        const sha = repo.refs.get(ref);
        if (!sha) return notFound();
        return {
          status: 200,
          body: json(ref, sha)
        };
      }
      if (method === 'POST' && !ref) {
        if (typeof input.ref !== 'string' || !input.ref.startsWith('refs/') || input.ref.includes('..') || /[\s~^:?*\[\\]/.test(input.ref) || !repo.objects.has(input.sha)) throw new ApiError(422, 'Invalid reference');
        if (repo.refs.has(input.ref)) throw new ApiError(422, 'Reference already exists');
        repo.refs.set(input.ref, input.sha);
        store.touch(repo);
        return {
          status: 201,
          body: json(input.ref, input.sha)
        };
      }
      if (method === 'DELETE' && ref) {
        if (!repo.refs.delete(ref)) return notFound();
        store.touch(repo);
        return {
          status: 204
        };
      }
      return notFound();
    }
    if (tail[0] === 'branches' && method === 'GET') {
      const branchJson = (name, sha) => ({
        name,
        commit: {
          sha
        },
        protected: false
      });
      if (tail.length > 1) {
        const name = tail.slice(1).join('/'),
          sha = repo.refs.get(`refs/heads/${name}`);
        if (!sha) return notFound();
        return {
          status: 200,
          body: branchJson(name, sha)
        };
      }
      return page([...repo.refs].filter(([name]) => name.startsWith('refs/heads/')).map(([name, sha]) => branchJson(name.slice(11), sha)), url);
    }
    if (tail[0] === 'commits' && method === 'GET') {
      if (tail.length > 1) {
        const sha = resolveRef(repo, tail.slice(1).join('/'));
        if (!sha) return notFound();
        return {
          status: 200,
          body: commitJson(repo, sha)
        };
      }
      const tip = peelObject(repo, resolveRef(repo, url.searchParams.get('sha') ?? undefined));
      const seen = new Set(),
        queue = tip ? [tip] : [],
        commits = [];
      for (let index = 0; index < queue.length; index++) {
        const sha = queue[index];
        if (seen.has(sha)) continue;
        seen.add(sha);
        const obj = repo.objects.get(sha);
        if (obj?.type !== 'commit') continue;
        commits.push(commitJson(repo, sha));
        queue.push(...parseCommit(obj.data).parents);
      }
      return page(commits, url);
    }
    if (tail[0] === 'labels') {
      if (tail.length === 1 && method === 'GET') return page([...repo.labels.values()], url);
      if (tail.length === 1 && method === 'POST') {
        validateFields(input, {
          name: 'string',
          color: 'string',
          description: 'string'
        });
        if (typeof input.name !== 'string' || !input.name) throw new ApiError(422, 'Label name is required');
        if (repo.labels.has(input.name)) throw new ApiError(422, 'Label already exists');
        const label = {
          id: store.nextId++,
          name: input.name,
          color: input.color ?? 'ededed',
          description: input.description ?? ''
        };
        repo.labels.set(label.name, label);
        return {
          status: 201,
          body: label
        };
      }
      const label = repo.labels.get(tail.slice(1).join('/'));
      if (!label) return notFound();
      if (method === 'GET') return {
        status: 200,
        body: label
      };
      if (method === 'DELETE') {
        repo.labels.delete(label.name);
        return {
          status: 204
        };
      }
      return notFound();
    }
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          validateIssueInput(input);
          return {
            status: 201,
            body: issueJson(store.createIssue(repo, input))
          };
        }
        if (method === 'GET') return page(store.listIssues(repo, {
          state: url.searchParams.get('state') ?? 'open',
          direction: url.searchParams.get('direction') ?? 'desc'
        }).map(issueJson), url);
        return notFound();
      }
      const number = Number(tail[1]),
        issue = repo.issues.get(number) ?? repo.pulls.get(number);
      if (!issue || !Number.isInteger(number)) return notFound();
      if (tail.length === 2) {
        if (method === 'GET') return issueReply(issue);
        if (method === 'PATCH') {
          validateIssueInput(input);
          return {
            status: 200,
            body: issueJson(store.updateIssue(repo, number, input))
          };
        }
        return notFound();
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'GET') return page(issue.commentList ?? [], url);
        if (method === 'POST') return {
          status: 201,
          body: store.addComment(repo, number, input.body)
        };
      }
      return notFound();
    }
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          validateIssueInput(input);
          validateFields(input, {
            head: 'string',
            base: 'string'
          });
          return {
            status: 201,
            body: pullJson(repo, store.createPull(repo, input))
          };
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open',
            direction = url.searchParams.get('direction') ?? 'desc';
          return page([...repo.pulls.values()].filter(pull => state === 'all' || pull.state === state).sort((a, b) => (direction === 'asc' ? 1 : -1) * (a.number - b.number)).map(pull => pullJson(repo, pull)), url);
        }
        return notFound();
      }
      const number = Number(tail[1]),
        pull = repo.pulls.get(number);
      if (!pull || !Number.isInteger(number)) return notFound();
      if (tail.length === 2 && method === 'GET') return {
        status: 200,
        body: pullJson(repo, pull)
      };
      if (tail.length === 2 && method === 'PATCH') {
        validateIssueInput(input);
        return {
          status: 200,
          body: pullJson(repo, store.updateIssue(repo, number, input))
        };
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') return page(store.pullFiles(repo, pull), url);
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        validateFields(input, {
          commit_title: 'string',
          commit_message: 'string',
          merge_method: 'string'
        });
        return {
          status: 200,
          body: store.mergePull(repo, number, input)
        };
      }
      return notFound();
    }
    return notFound();
  } catch (error) {
    if (error instanceof ApiError) return {
      status: error.status,
      body: {
        message: error.message
      }
    };
    if (error instanceof URIError) return {
      status: 400,
      body: {
        message: 'Invalid URL encoding'
      }
    };
    throw error;
  }
}
const stringProperty = description => ({
  type: 'string',
  description
});
const ownerRepo = {
  owner: stringProperty('Repository owner login'),
  repo: stringProperty('Repository name')
};
function tool(name, description, properties, required) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false
    }
  };
}
const tools = [tool('create_repo', 'Create a repository owned by the authenticated user.', {
  name: stringProperty('Repository name'),
  description: stringProperty('Repository description'),
  private: {
    type: 'boolean',
    description: 'Whether the repository is private'
  }
}, ['name']), tool('get_repo', 'Get a repository and its stable identity.', ownerRepo, ['owner', 'repo']), tool('create_issue', 'Create an issue in a repository.', {
  ...ownerRepo,
  title: stringProperty('Issue title'),
  body: stringProperty('Issue body'),
  labels: {
    type: 'array',
    items: {
      type: 'string'
    },
    description: 'Existing label names'
  }
}, ['owner', 'repo', 'title']), tool('list_issues', 'List repository issues, filtered by state.', {
  ...ownerRepo,
  state: {
    type: 'string',
    enum: ['open', 'closed', 'all'],
    description: 'Issue state to include'
  }
}, ['owner', 'repo']), tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
  ...ownerRepo,
  title: stringProperty('Pull request title'),
  body: stringProperty('Pull request body'),
  head: stringProperty('Head branch name'),
  base: stringProperty('Base branch name')
}, ['owner', 'repo', 'title', 'head', 'base']), tool('merge_pull_request', 'Squash merge a conflict-free pull request into its base branch.', {
  ...ownerRepo,
  pull_number: {
    type: 'integer',
    minimum: 1,
    description: 'Pull request number'
  }
}, ['owner', 'repo', 'pull_number'])];
const versions = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const serverInfo = {
  name: 'native-github-forge',
  version: '1.0.0'
};
const capabilities = {
  tools: {
    listChanged: false
  }
};
function rpc(store, request) {
  const id = typeof request?.id === 'string' || typeof request?.id === 'number' && Number.isFinite(request.id) ? request.id : null;
  const error = (code, message, data) => ({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : {
        data
      })
    }
  });
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || request.id !== undefined && request.id !== null && typeof request.id !== 'string' && (typeof request.id !== 'number' || !Number.isFinite(request.id))) return error(-32600, 'Invalid Request');
  const params = request.params ?? {};
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return error(-32602, 'Invalid params');
  const revision = params._meta?.['io.modelcontextprotocol/protocolVersion'] ?? params._meta?.protocolVersion ?? request._meta?.['io.modelcontextprotocol/protocolVersion'] ?? request._meta?.protocolVersion;
  if (revision && !versions.includes(revision)) return error(-32022, 'Unsupported protocol version', {
    supported: versions
  });
  const success = result => ({
    jsonrpc: '2.0',
    id,
    result
  });
  if (request.method === 'server/discover') return success({
    resultType: 'server/discover',
    serverInfo,
    capabilities,
    supportedVersions: versions
  });
  if (request.method === 'initialize') return success({
    protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
    serverInfo,
    capabilities
  });
  if (request.method === 'ping') return success({});
  if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return undefined;
  if (request.method === 'tools/list') return success({
    tools
  });
  if (request.method !== 'tools/call') return error(-32601, 'Method not found');
  const definition = tools.find(tool => tool.name === params.name);
  if (!definition) return error(-32602, 'Unknown tool');
  const args = params.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return error(-32602, 'Arguments must be an object');
  for (const key of definition.inputSchema.required) {
    const property = definition.inputSchema.properties[key];
    if (!(key in args) || property.type === 'string' && (typeof args[key] !== 'string' || args[key].length === 0) || property.type === 'integer' && (!Number.isInteger(args[key]) || args[key] < 1)) return error(-32602, `Missing or invalid argument: ${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const property = definition.inputSchema.properties[key];
    if (!property) return error(-32602, `Unknown argument: ${key}`);
    if (property.type === 'string' && typeof value !== 'string' || property.type === 'boolean' && typeof value !== 'boolean' || property.type === 'array' && (!Array.isArray(value) || value.some(item => typeof item !== 'string')) || property.type === 'integer' && !Number.isInteger(value)) return error(-32602, `Invalid argument: ${key}`);
    if (property.enum && !property.enum.includes(value)) return error(-32602, `Invalid argument: ${key}`);
  }
  try {
    let result;
    if (definition.name === 'create_repo') result = store.repoJson(store.createRepo(args));else {
      const repo = store.getRepo(args.owner, args.repo);
      if (definition.name === 'get_repo') result = store.repoJson(repo);else if (definition.name === 'create_issue') result = issueJson(store.createIssue(repo, args));else if (definition.name === 'list_issues') result = store.listIssues(repo, {
        state: args.state ?? 'open'
      }).map(issueJson);else if (definition.name === 'create_pull_request') result = pullJson(repo, store.createPull(repo, args));else result = store.mergePull(repo, args.pull_number, args);
    }
    return success({
      content: [{
        type: 'text',
        text: JSON.stringify(result)
      }],
      structuredContent: result,
      isError: false
    });
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return success({
      content: [{
        type: 'text',
        text: JSON.stringify({
          message: err.message,
          status: err.status
        })
      }],
      isError: true
    });
  }
}

/** Stateless Streamable HTTP transport preserves each request's JSON-RPC id. */
export function mcp(store, body, method = 'POST') {
  if (method === 'DELETE') return {
    status: 204
  };
  if (method !== 'POST') return {
    status: 405,
    body: {
      message: 'Method Not Allowed'
    },
    headers: {
      Allow: 'POST, DELETE'
    }
  };
  if (Array.isArray(body)) {
    if (body.length === 0) return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Invalid Request'
        }
      }
    };
    const responses = body.map(request => {
      const response = rpc(store, request);
      const notification = request && typeof request === 'object' && request.jsonrpc === '2.0' && typeof request.method === 'string' && request.id === undefined;
      return notification ? undefined : response;
    }).filter(response => response !== undefined);
    return responses.length ? {
      status: 200,
      body: responses
    } : {
      status: 202
    };
  }
  const result = rpc(store, body);
  const notification = body && typeof body === 'object' && body.jsonrpc === '2.0' && typeof body.method === 'string' && body.id === undefined;
  return result === undefined || notification ? {
    status: 202
  } : {
    status: 200,
    body: result
  };
}
