import { createHash } from 'node:crypto';
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const ZERO = '0'.repeat(40);
export const nodeId = (kind, id) => Buffer.from(`${kind}:${id}`).toString('base64');
export function putObject(repo, type, data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const oid = createHash('sha1').update(`${type} ${b.length}\0`).update(b).digest('hex');
  repo.objects.set(oid, {
    type,
    data: b
  });
  return oid;
}
export function parseCommit(data) {
  const text = data.toString();
  const split = text.indexOf('\n\n');
  const h = text.slice(0, split).split('\n');
  return {
    tree: h.find(x => x.startsWith('tree '))?.slice(5) ?? '',
    parents: h.filter(x => x.startsWith('parent ')).map(x => x.slice(7)),
    message: text.slice(split + 2)
  };
}
export function parseTree(data) {
  const out = [];
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(32, p),
      nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('Invalid tree');
    out.push({
      mode: data.toString('ascii', p, sp),
      name: data.toString('utf8', sp + 1, nul),
      oid: data.subarray(nul + 1, nul + 21).toString('hex')
    });
    p = nul + 21;
  }
  return out;
}
export function resolveRef(repo, ref) {
  return repo.refs.get(ref ?? `refs/heads/${repo.default_branch}`) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? (ref && repo.objects.has(ref) ? ref : undefined);
}
export function peelObject(repo, oid) {
  const seen = new Set();
  while (oid && !seen.has(oid)) {
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object?.type !== 'tag') return oid;
    oid = object.data.toString().split('\n').find(line => line.startsWith('object '))?.slice(7);
  }
  return undefined;
}
export function filesAt(repo, ref) {
  const files = new Map();
  const oid = peelObject(repo, resolveRef(repo, ref));
  if (!oid) return files;
  const commit = repo.objects.get(oid);
  if (!commit) return files;
  let tree = commit.type === 'tree' ? oid : parseCommit(commit.data).tree;
  const walk = (id, prefix) => {
    const obj = repo.objects.get(id);
    if (!obj) return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000' || e.mode === '040000') walk(e.oid, prefix + e.name + '/');else files.set(prefix + e.name, {
        oid: e.oid,
        mode: e.mode
      });
    }
  };
  walk(tree, '');
  return files;
}
export function commitFiles(repo, files, parents, message, epoch = 1700000000) {
  const build = prefix => {
    const entries = new Map();
    for (const [path, e] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length),
        slash = rest.indexOf('/');
      if (slash < 0) entries.set(rest, e);else entries.set(rest.slice(0, slash), {
        oid: '',
        mode: '40000'
      });
    }
    const parts = [];
    const sorted = [...entries].sort(([a, ea], [b, eb]) => Buffer.compare(Buffer.from(a + (ea.mode === '40000' ? '/' : '')), Buffer.from(b + (eb.mode === '40000' ? '/' : ''))));
    for (const [name, e] of sorted) {
      const oid = e.mode === '40000' ? build(prefix + name + '/') : e.oid;
      parts.push(Buffer.from(`${e.mode} ${name}\0`), Buffer.from(oid, 'hex'));
    }
    return putObject(repo, 'tree', Buffer.concat(parts));
  };
  const tree = build('');
  const identity = `Forge <forge@example.invalid> ${epoch} +0000`;
  return putObject(repo, 'commit', `tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author ${identity}\ncommitter ${identity}\n\n${message.replace(/\n?$/, '\n')}`);
}
export function isAncestor(repo, ancestor, tip) {
  const seen = new Set(),
    stack = [tip];
  while (stack.length) {
    const id = stack.pop();
    if (id === ancestor) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const o = repo.objects.get(id);
    if (o?.type === 'commit') stack.push(...parseCommit(o.data).parents);
  }
  return false;
}
export function mergeBase(repo, a, b) {
  const distance = tip => {
    const d = new Map();
    const q = [[tip, 0]];
    for (let p = 0; p < q.length; p++) {
      const [id, n] = q[p];
      if (d.has(id)) continue;
      d.set(id, n);
      const o = repo.objects.get(id);
      if (o?.type === 'commit') for (const parent of parseCommit(o.data).parents) q.push([parent, n + 1]);
    }
    return d;
  };
  const da = distance(a),
    db = distance(b),
    common = [...da.keys()].filter(id => db.has(id));
  const dominated = new Set();
  for (const id of common) {
    const obj = repo.objects.get(id),
      stack = obj?.type === 'commit' ? [...parseCommit(obj.data).parents] : [],
      seen = new Set();
    while (stack.length) {
      const ancestor = stack.pop();
      if (seen.has(ancestor)) continue;
      seen.add(ancestor);
      if (da.has(ancestor) && db.has(ancestor)) dominated.add(ancestor);
      const o = repo.objects.get(ancestor);
      if (o?.type === 'commit') stack.push(...parseCommit(o.data).parents);
    }
  }
  return common.filter(id => !dominated.has(id)).sort((x, y) => da.get(x) + db.get(x) - (da.get(y) + db.get(y)) || x.localeCompare(y))[0];
}
function lineEdits(base, changed) {
  // Each edit names a half-open interval of ancestor lines. Unchanged lines are
  // anchors, so independent changes can be applied without losing either side.
  if (base.length * changed.length > 4_000_000) {
    let start = 0,
      end = base.length,
      nextEnd = changed.length;
    while (start < end && start < nextEnd && base[start] === changed[start]) start++;
    while (end > start && nextEnd > start && base[end - 1] === changed[nextEnd - 1]) {
      end--;
      nextEnd--;
    }
    return start === end && start === nextEnd ? [] : [{
      start,
      end,
      lines: changed.slice(start, nextEnd)
    }];
  }
  const width = changed.length + 1,
    table = new Uint32Array((base.length + 1) * width);
  for (let i = base.length - 1; i >= 0; i--) for (let j = changed.length - 1; j >= 0; j--) table[i * width + j] = base[i] === changed[j] ? 1 + table[(i + 1) * width + j + 1] : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const edits = [];
  let i = 0,
    j = 0,
    current;
  const flush = () => {
    if (current) {
      edits.push(current);
      current = undefined;
    }
  };
  while (i < base.length || j < changed.length) {
    if (i < base.length && j < changed.length && base[i] === changed[j]) {
      flush();
      i++;
      j++;
      continue;
    }
    current ??= {
      start: i,
      end: i,
      lines: []
    };
    if (j < changed.length && (i === base.length || table[i * width + j + 1] > table[(i + 1) * width + j])) current.lines.push(changed[j++]);else current.end = ++i;
  }
  flush();
  return edits;
}
export function mergeText(base, ours, theirs) {
  const decode = b => {
    const s = b.toString('utf8');
    if (s.includes('\0') || !Buffer.from(s).equals(b)) throw new ApiError(405, 'Merge conflict');
    return s.split(/(?<=\n)/);
  };
  const a = decode(base),
    o = lineEdits(a, decode(ours)),
    t = lineEdits(a, decode(theirs));
  const edits = [...o];
  for (const next of t) {
    let duplicate = false;
    for (const old of o) {
      if (old.start === next.start && old.end === next.end && old.lines.join('') === next.lines.join('')) {
        duplicate = true;
        break;
      }
      const overlap = Math.max(old.start, next.start) < Math.min(old.end, next.end) || old.start === old.end && next.start === next.end && old.start === next.start || old.start === old.end && old.start > next.start && old.start < next.end || next.start === next.end && next.start > old.start && next.start < old.end;
      if (overlap) throw new ApiError(405, 'Merge conflict');
    }
    if (!duplicate) edits.push(next);
  }
  edits.sort((x, y) => y.start - x.start || y.end - x.end);
  for (const e of edits) a.splice(e.start, e.end - e.start, ...e.lines);
  return Buffer.from(a.join(''));
}
export class Store {
  repos = new Map();
  nodes = new Map();
  viewer = 'viewer';
  ownerBound = false;
  nextId = 1;
  clock = 0;
  time() {
    return new Date(1700000000000 + this.clock++ * 1000).toISOString();
  }
  bindOwner(owner) {
    if (!this.ownerBound) {
      this.viewer = owner;
      this.ownerBound = true;
      for (const r of this.repos.values()) r.owner.login = owner;
    }
  }
  user() {
    return {
      login: this.viewer,
      id: 1,
      node_id: nodeId('User', 1)
    };
  }
  createRepo(input) {
    if (typeof input.name !== 'string' || !input.name || input.name.includes('/')) throw new ApiError(422, 'Invalid repository name');
    if (this.repos.has(input.name.toLowerCase())) throw new ApiError(422, 'Repository already exists');
    const id = this.nextId++;
    const repo = {
      id,
      node_id: nodeId('Repository', id),
      name: input.name,
      owner: {
        login: this.viewer
      },
      private: !!input.private,
      description: input.description ?? '',
      default_branch: input.default_branch ?? 'main',
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      version: 0,
      packCache: new Map()
    };
    this.repos.set(repo.name.toLowerCase(), repo);
    this.nodes.set(repo.node_id, repo);
    return repo;
  }
  getRepo(owner, name) {
    const r = this.repos.get(name.toLowerCase());
    if (r && !this.ownerBound) this.bindOwner(owner);
    if (!r || owner.toLowerCase() !== this.viewer.toLowerCase()) throw new ApiError(404, 'Not Found');
    return r;
  }
  repoJson(r) {
    return {
      id: r.id,
      node_id: r.node_id,
      name: r.name,
      full_name: `${r.owner.login}/${r.name}`,
      owner: r.owner,
      private: r.private,
      description: r.description,
      default_branch: r.default_branch,
      has_issues: true
    };
  }
  touch(r) {
    r.version++;
    r.packCache.clear();
  }
  createIssue(r, input) {
    if (typeof input.title !== 'string' || !input.title) throw new ApiError(422, 'Title is required');
    const labels = (input.labels ?? []).map(x => {
      const l = r.labels.get(typeof x === 'string' ? x : x.name);
      if (!l) throw new ApiError(422, 'Unknown label');
      return l;
    });
    const id = this.nextId++,
      date = this.time();
    const issue = {
      id,
      node_id: nodeId('Issue', id),
      number: r.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
      user: this.user(),
      created_at: date,
      updated_at: date,
      comments: 0
    };
    r.issues.set(issue.number, issue);
    this.nodes.set(issue.node_id, {
      repo: r,
      issue
    });
    return issue;
  }
  updateIssue(r, n, input) {
    const i = r.issues.get(n) ?? r.pulls.get(n);
    if (!i) throw new ApiError(404, 'Not Found');
    for (const key of ['title', 'body', 'state']) if (input[key] !== undefined) i[key] = input[key];
    i.updated_at = this.time();
    return i;
  }
  listIssues(r, args = {}) {
    return [...r.issues.values(), ...r.pulls.values()].filter(i => !args.state || args.state === 'all' || i.state === args.state.toLowerCase()).sort((a, b) => (args.direction?.toLowerCase() === 'asc' ? 1 : -1) * (a.number - b.number));
  }
  addComment(r, n, body) {
    const i = r.issues.get(n) ?? r.pulls.get(n);
    if (!i) throw new ApiError(404, 'Not Found');
    if (typeof body !== 'string') throw new ApiError(422, 'Body required');
    const id = this.nextId++,
      c = {
        id,
        node_id: nodeId('IssueComment', id),
        body,
        user: this.user(),
        created_at: this.time()
      };
    (i.commentList ??= []).push(c);
    i.comments = i.commentList.length;
    this.nodes.set(c.node_id, {
      repo: r,
      comment: c
    });
    return c;
  }
  createPull(r, input) {
    const head = String(input.head ?? '').split(':').pop(),
      base = input.base ?? r.default_branch;
    if (!input.title || !resolveRef(r, head) || !resolveRef(r, base)) throw new ApiError(422, 'Invalid pull request');
    const id = this.nextId++,
      date = this.time(),
      pull = {
        id,
        node_id: nodeId('PullRequest', id),
        number: r.nextNumber++,
        title: input.title,
        body: input.body ?? '',
        state: 'open',
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        head: {
          ref: head,
          sha: resolveRef(r, head)
        },
        base: {
          ref: base,
          sha: resolveRef(r, base)
        },
        created_at: date,
        updated_at: date,
        user: this.user(),
        labels: []
      };
    r.pulls.set(pull.number, pull);
    this.nodes.set(pull.node_id, {
      repo: r,
      pull
    });
    return pull;
  }
  pullFiles(r, p) {
    const base = resolveRef(r, p.base.ref),
      head = resolveRef(r, p.head.ref);
    const a = filesAt(r, mergeBase(r, base, head) ?? base),
      b = filesAt(r, head);
    return [...new Set([...a.keys(), ...b.keys()])].sort().filter(path => a.get(path)?.oid !== b.get(path)?.oid || a.get(path)?.mode !== b.get(path)?.mode).map(path => {
      const old = a.get(path),
        next = b.get(path);
      const countLines = entry => {
        const text = entry ? r.objects.get(entry.oid).data.toString() : '';
        return text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
      };
      const oldLines = countLines(old),
        newLines = countLines(next);
      return {
        filename: path,
        path,
        status: !old ? 'added' : !next ? 'removed' : 'modified',
        additions: newLines,
        deletions: oldLines,
        changes: newLines + oldLines,
        sha: next?.oid ?? old?.oid
      };
    });
  }
  mergedFiles(r, p, persist = true) {
    const base = resolveRef(r, p.base.ref),
      head = resolveRef(r, p.head.ref),
      common = mergeBase(r, base, head);
    const ancestor = common ? filesAt(r, common) : new Map(),
      ours = filesAt(r, base),
      theirs = filesAt(r, head),
      result = new Map(ours);
    const same = (a, b) => a?.oid === b?.oid && a?.mode === b?.mode;
    for (const path of new Set([...ancestor.keys(), ...ours.keys(), ...theirs.keys()])) {
      const a = ancestor.get(path),
        o = ours.get(path),
        t = theirs.get(path);
      if (same(t, a) || same(o, t)) continue;
      if (same(o, a)) {
        if (t) result.set(path, t);else result.delete(path);
        continue;
      }
      if (!a || !o || !t) throw new ApiError(405, 'Merge conflict');
      const mode = o.mode === t.mode ? o.mode : o.mode === a.mode ? t.mode : t.mode === a.mode ? o.mode : undefined;
      if (!mode) throw new ApiError(405, 'Merge conflict');
      let oid = o.oid;
      if (o.oid === a.oid) oid = t.oid;else if (t.oid !== a.oid && o.oid !== t.oid) {
        if (!['100644', '100755'].includes(mode)) throw new ApiError(405, 'Merge conflict');
        const merged = mergeText(r.objects.get(a.oid).data, r.objects.get(o.oid).data, r.objects.get(t.oid).data);
        if (persist) oid = putObject(r, 'blob', merged);
      }
      result.set(path, {
        mode,
        oid
      });
    }
    // A directory/file collision cannot be represented by a Git tree.
    for (const path of result.keys()) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) if (result.has(parts.slice(0, i).join('/'))) throw new ApiError(405, 'Merge conflict');
    }
    return result;
  }
  mergePull(r, n, input = {}) {
    const p = r.pulls.get(n);
    if (!p) throw new ApiError(404, 'Not Found');
    if (p.merged) throw new ApiError(405, 'Already merged');
    const files = this.mergedFiles(r, p),
      parent = resolveRef(r, p.base.ref);
    const sha = commitFiles(r, files, [parent], input.commit_title ?? `${p.title} (#${n})`, 1700000000 + this.clock++);
    r.refs.set(`refs/heads/${p.base.ref}`, sha);
    this.touch(r);
    p.state = 'closed';
    p.merged = true;
    p.merged_at = this.time();
    p.merge_commit_sha = sha;
    return {
      sha,
      merged: true,
      message: 'Pull Request successfully merged'
    };
  }
}
