import { ApiError, resolveRef, Store, type Repo } from './domain.ts';

type Value = { kind: 'variable'; name: string } | { kind: 'literal'; value: any } | { kind: 'list'; values: Value[] } | { kind: 'object'; fields: Record<string, Value> };
type Directive = { name: string; args: Record<string, Value> };
type Selection = { name?: string; alias?: string; args?: Record<string, Value>; children?: Selection[]; fragment?: string; condition?: string; directives: Directive[] };
type Operation = { kind: string; name?: string; defaults: Record<string, Value>; variables: Record<string, string>; required: string[]; children: Selection[] };
type Document = { operations: Operation[]; fragments: Map<string, { condition: string; children: Selection[]; directives: Directive[] }> };
type Token = { kind: string; text: string; value?: any; offset: number };

function lex(source: string): Token[] {
  const out: Token[] = [];
  let p = 0;
  while (p < source.length) {
    const ch = source[p];
    if (ch === ',' || ch === '\ufeff' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { p++; continue; }
    if (ch === '#') { while (p < source.length && source[p] !== '\n') p++; continue; }
    const start = p;
    if (source.slice(p, p + 3) === '...') { out.push({ kind: 'punct', text: '...', offset: p }); p += 3; continue; }
    if (ch === '"') {
      if (source.slice(p, p + 3) === '"""') {
        p += 3;
        let text = '';
        while (p < source.length && source.slice(p, p + 3) !== '"""') {
          if (source.slice(p, p + 4) === '\\"""') { text += '"""'; p += 4; }
          else text += source[p++];
        }
        if (p === source.length) throw new Error('Unterminated block string');
        p += 3;
        const lines = text.replace(/\r\n?/g, '\n').split('\n');
        const indents = lines.slice(1).filter(line => line.trim()).map(line => line.length - line.trimStart().length);
        const common = indents.length ? Math.min(...indents) : 0;
        for (let i = 1; i < lines.length; i++) lines[i] = lines[i].slice(common);
        while (lines.length && !lines[0].trim()) lines.shift();
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        out.push({ kind: 'string', text: source.slice(start, p), value: lines.join('\n'), offset: start });
      } else {
        p++;
        while (p < source.length) {
          if (source[p] === '\\') { p += 2; continue; }
          if (source[p++] === '"') break;
        }
        const raw = source.slice(start, p);
        out.push({ kind: 'string', text: raw, value: JSON.parse(raw), offset: start });
      }
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      if (ch === '-') p++;
      while (p < source.length && source[p] >= '0' && source[p] <= '9') p++;
      if (source[p] === '.') { p++; while (p < source.length && source[p] >= '0' && source[p] <= '9') p++; }
      if (source[p] === 'e' || source[p] === 'E') { p++; if (source[p] === '+' || source[p] === '-') p++; while (p < source.length && source[p] >= '0' && source[p] <= '9') p++; }
      const raw = source.slice(start, p), value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`Invalid number at ${start}`);
      out.push({ kind: 'number', text: raw, value, offset: start }); continue;
    }
    if (ch === '_' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      p++;
      while (p < source.length) { const c = source[p]; if (!(c === '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) break; p++; }
      out.push({ kind: 'name', text: source.slice(start, p), offset: start }); continue;
    }
    if ('!$():=@[]{|}&'.includes(ch)) { out.push({ kind: 'punct', text: ch, offset: p++ }); continue; }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at ${p}`);
  }
  out.push({ kind: 'eof', text: '', offset: p });
  return out;
}

class Parser {
  tokens: Token[]; p = 0;
  constructor(source: string) { this.tokens = lex(source); }
  peek(text?: string) { return text === undefined ? this.tokens[this.p].text : this.tokens[this.p].text === text; }
  take(text?: string): Token { const token = this.tokens[this.p++]; if (text !== undefined && token.text !== text) throw new Error(`Expected ${text} at ${token.offset}`); return token; }
  name(): string { const token = this.take(); if (token.kind !== 'name') throw new Error(`Expected a name at ${token.offset}`); return token.text; }
  optional(text: string): boolean { if (this.peek(text)) { this.p++; return true; } return false; }
  value(): Value {
    if (this.optional('$')) return { kind: 'variable', name: this.name() };
    if (this.optional('[')) { const values: Value[] = []; while (!this.optional(']')) values.push(this.value()); return { kind: 'list', values }; }
    if (this.optional('{')) { const fields: Record<string, Value> = {}; while (!this.optional('}')) { const name = this.name(); this.take(':'); fields[name] = this.value(); } return { kind: 'object', fields }; }
    const token = this.take();
    if (token.kind === 'string' || token.kind === 'number') return { kind: 'literal', value: token.value };
    if (token.kind === 'name') return { kind: 'literal', value: token.text === 'null' ? null : token.text === 'true' ? true : token.text === 'false' ? false : token.text };
    throw new Error(`Expected a value at ${token.offset}`);
  }
  args(): Record<string, Value> { const args: Record<string, Value> = {}; if (this.optional('(')) while (!this.optional(')')) { const name = this.name(); this.take(':'); args[name] = this.value(); } return args; }
  directives(): Directive[] { const result: Directive[] = []; while (this.optional('@')) result.push({ name: this.name(), args: this.args() }); return result; }
  type(): string { let type: string; if (this.optional('[')) { type = `[${this.type()}]`; this.take(']'); } else type = this.name(); if (this.optional('!')) type += '!'; return type; }
  selections(): Selection[] {
    this.take('{'); const selections: Selection[] = [];
    while (!this.optional('}')) {
      if (this.optional('...')) {
        if (this.optional('on')) { const condition = this.name(), directives = this.directives(); selections.push({ condition, directives, children: this.selections() }); }
        else if (this.peek('@') || this.peek('{')) { const directives = this.directives(); selections.push({ directives, children: this.selections() }); }
        else { const fragment = this.name(); selections.push({ fragment, directives: this.directives() }); }
      } else {
        let name = this.name(), alias: string | undefined;
        if (this.optional(':')) { alias = name; name = this.name(); }
        const args = this.args(), directives = this.directives();
        const children = this.peek('{') ? this.selections() : undefined;
        selections.push({ name, alias, args, directives, children });
      }
    }
    return selections;
  }
  document(): Document {
    const operations: Operation[] = [], fragments = new Map<string, { condition: string; children: Selection[]; directives: Directive[] }>();
    while (this.tokens[this.p].kind !== 'eof') {
      if (this.peek('{')) { operations.push({ kind: 'query', defaults: {}, variables: {}, required: [], children: this.selections() }); continue; }
      const kind = this.name();
      if (kind === 'fragment') { const name = this.name(); this.take('on'); const condition = this.name(), directives = this.directives(), children = this.selections(); if (fragments.has(name)) throw new Error(`Duplicate fragment ${name}`); fragments.set(name, { condition, directives, children }); continue; }
      if (kind !== 'query' && kind !== 'mutation' && kind !== 'subscription') throw new Error(`Unknown operation ${kind}`);
      const name = this.tokens[this.p].kind === 'name' ? this.name() : undefined;
      const defaults: Record<string, Value> = {}, variables: Record<string, string> = {}, required: string[] = [];
      if (this.optional('(')) while (!this.optional(')')) { this.take('$'); const variable = this.name(); if (variables[variable]) throw new Error(`Duplicate variable $${variable}`); this.take(':'); const type = this.type(); variables[variable] = type; if (type.endsWith('!')) required.push(variable); if (this.optional('=')) defaults[variable] = this.value(); this.directives(); }
      this.directives(); operations.push({ kind, name, defaults, variables, required, children: this.selections() });
    }
    if (!operations.length) throw new Error('A GraphQL operation is required');
    return { operations, fragments };
  }
}

function evaluate(value: Value, variables: Record<string, any>): any {
  switch (value.kind) {
    case 'variable': return variables[value.name];
    case 'literal': return value.value;
    case 'list': return value.values.map(v => evaluate(v, variables));
    case 'object': return Object.fromEntries(Object.entries(value.fields).map(([k, v]) => [k, evaluate(v, variables)]));
  }
}
function argumentsOf(args: Record<string, Value> | undefined, variables: Record<string, any>) { return Object.fromEntries(Object.entries(args ?? {}).map(([name, value]) => [name, evaluate(value, variables)])); }
function included(directives: Directive[], variables: Record<string, any>) { return directives.every(d => d.name === 'skip' ? !argumentsOf(d.args, variables).if : d.name === 'include' ? !!argumentsOf(d.args, variables).if : true); }

type Field = { type: string; args?: Record<string, string> };
const f = (type: string, args?: Record<string, string>): Field => ({ type, args });
const schemas: Record<string, Record<string, Field>> = {
  Query: { viewer: f('User!'), repository: f('Repository', { owner: 'String!', name: 'String!' }), node: f('Node', { id: 'ID!' }), nodes: f('[Node]', { ids: '[ID!]!' }), __type: f('__Type', { name: 'String!' }), __schema: f('__Schema!'), search: f('SearchResultItemConnection!', { query: 'String!', type: 'SearchType!', first: 'Int', after: 'String' }) },
  Mutation: { createIssue: f('CreateIssuePayload', { input: 'CreateIssueInput!' }), closeIssue: f('CloseIssuePayload', { input: 'CloseIssueInput!' }), reopenIssue: f('ReopenIssuePayload', { input: 'ReopenIssueInput!' }), updateIssue: f('UpdateIssuePayload', { input: 'UpdateIssueInput!' }), createPullRequest: f('CreatePullRequestPayload', { input: 'CreatePullRequestInput!' }), mergePullRequest: f('MergePullRequestPayload', { input: 'MergePullRequestInput!' }), closePullRequest: f('ClosePullRequestPayload', { input: 'ClosePullRequestInput!' }), updatePullRequest: f('UpdatePullRequestPayload', { input: 'UpdatePullRequestInput!' }), addComment: f('AddCommentPayload', { input: 'AddCommentInput!' }) },
  User: { id: f('ID!'), databaseId: f('Int'), login: f('String!'), name: f('String'), email: f('String!'), repositories: f('RepositoryConnection!', { first: 'Int', after: 'String', orderBy: 'RepositoryOrder' }) },
  Repository: { id: f('ID!'), databaseId: f('Int'), name: f('String!'), nameWithOwner: f('String!'), owner: f('User!'), description: f('String'), isPrivate: f('Boolean!'), defaultBranchRef: f('Ref'), viewerPermission: f('RepositoryPermission'), hasIssuesEnabled: f('Boolean!'), issue: f('Issue', { number: 'Int!' }), issues: f('IssueConnection!', { first: 'Int', after: 'String', last: 'Int', before: 'String', states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]' }), pullRequest: f('PullRequest', { number: 'Int!' }), pullRequests: f('PullRequestConnection!', { first: 'Int', after: 'String', last: 'Int', before: 'String', states: '[PullRequestState!]', orderBy: 'IssueOrder', headRefName: 'String', baseRefName: 'String' }), ref: f('Ref', { qualifiedName: 'String!' }), refs: f('RefConnection!', { refPrefix: 'String!', first: 'Int', after: 'String' }) },
  Ref: { id: f('ID!'), name: f('String!'), prefix: f('String!'), target: f('Commit') },
  Commit: { id: f('ID!'), oid: f('String!'), message: f('String!') },
  Issue: { id: f('ID!'), databaseId: f('Int'), number: f('Int!'), title: f('String!'), body: f('String!'), state: f('IssueState!'), createdAt: f('DateTime!'), updatedAt: f('DateTime!'), closed: f('Boolean!'), author: f('User'), repository: f('Repository!'), comments: f('IssueCommentConnection!', { first: 'Int', after: 'String' }), labels: f('LabelConnection!', { first: 'Int', after: 'String' }) },
  PullRequest: { id: f('ID!'), databaseId: f('Int'), number: f('Int!'), title: f('String!'), body: f('String!'), state: f('PullRequestState!'), createdAt: f('DateTime!'), updatedAt: f('DateTime!'), headRefName: f('String!'), baseRefName: f('String!'), headRefOid: f('String!'), baseRefOid: f('String!'), mergeable: f('MergeableState!'), merged: f('Boolean!'), mergedAt: f('DateTime'), closed: f('Boolean!'), author: f('User'), repository: f('Repository!'), files: f('PullRequestChangedFileConnection', { first: 'Int', after: 'String' }), comments: f('IssueCommentConnection!', { first: 'Int', after: 'String' }), labels: f('LabelConnection!', { first: 'Int', after: 'String' }) },
  PullRequestChangedFile: { path: f('String!'), additions: f('Int!'), deletions: f('Int!'), changeType: f('String!') },
  IssueComment: { id: f('ID!'), databaseId: f('Int'), body: f('String!'), createdAt: f('DateTime!'), author: f('User') },
  Label: { id: f('ID!'), name: f('String!'), color: f('String!'), description: f('String') },
  PageInfo: { hasNextPage: f('Boolean!'), hasPreviousPage: f('Boolean!'), startCursor: f('String'), endCursor: f('String') },
  Node: { id: f('ID!') },
  __Schema: { queryType: f('__Type!'), mutationType: f('__Type'), subscriptionType: f('__Type'), types: f('[__Type!]!'), directives: f('[__Directive!]!'), description: f('String') },
  __Type: { kind: f('__TypeKind!'), name: f('String'), description: f('String'), fields: f('[__Field!]', { includeDeprecated: 'Boolean' }), interfaces: f('[__Type!]'), possibleTypes: f('[__Type!]'), enumValues: f('[__EnumValue!]', { includeDeprecated: 'Boolean' }), inputFields: f('[__InputValue!]', { includeDeprecated: 'Boolean' }), ofType: f('__Type'), specifiedByURL: f('String'), isOneOf: f('Boolean') },
  __Field: { name: f('String!'), description: f('String'), args: f('[__InputValue!]!'), type: f('__Type!'), isDeprecated: f('Boolean!'), deprecationReason: f('String') },
  __InputValue: { name: f('String!'), description: f('String'), type: f('__Type!'), defaultValue: f('String'), isDeprecated: f('Boolean!'), deprecationReason: f('String') },
  __EnumValue: { name: f('String!'), description: f('String'), isDeprecated: f('Boolean!'), deprecationReason: f('String') },
  __Directive: { name: f('String!'), description: f('String'), locations: f('[__DirectiveLocation!]!'), args: f('[__InputValue!]!'), isRepeatable: f('Boolean!') },
};
const enums: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'], RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'], SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'], IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], OrderDirection: ['ASC', 'DESC'], RepositoryOrderField: ['CREATED_AT', 'UPDATED_AT', 'PUSHED_AT', 'NAME'], __TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'], __DirectiveLocation: ['QUERY', 'MUTATION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'],
};
const inputs: Record<string, Record<string, string>> = {
  CreateIssueInput: { repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]', clientMutationId: 'String' }, CloseIssueInput: { issueId: 'ID!', clientMutationId: 'String' }, ReopenIssueInput: { issueId: 'ID!', clientMutationId: 'String' }, UpdateIssueInput: { id: 'ID!', title: 'String', body: 'String', clientMutationId: 'String' }, CreatePullRequestInput: { repositoryId: 'ID!', title: 'String!', body: 'String', headRefName: 'String!', baseRefName: 'String!', draft: 'Boolean', clientMutationId: 'String' }, MergePullRequestInput: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod!', commitHeadline: 'String', commitBody: 'String', clientMutationId: 'String' }, ClosePullRequestInput: { pullRequestId: 'ID!', clientMutationId: 'String' }, UpdatePullRequestInput: { pullRequestId: 'ID!', title: 'String', body: 'String', clientMutationId: 'String' }, AddCommentInput: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' }, IssueOrder: { field: 'IssueOrderField!', direction: 'OrderDirection!' }, RepositoryOrder: { field: 'RepositoryOrderField!', direction: 'OrderDirection!' },
};
for (const type of ['Repository', 'Issue', 'PullRequest', 'PullRequestChangedFile', 'IssueComment', 'Label', 'Ref', 'SearchResultItem']) {
  schemas[`${type}Connection`] = { nodes: f(`[${type}!]!`), edges: f(`[${type}Edge!]!`), pageInfo: f('PageInfo!'), totalCount: f('Int!') };
  schemas[`${type}Edge`] = { node: f(type), cursor: f('String!') };
}
for (const mutation of ['CreateIssue', 'CloseIssue', 'ReopenIssue', 'UpdateIssue']) schemas[`${mutation}Payload`] = { issue: f('Issue'), clientMutationId: f('String') };
for (const mutation of ['CreatePullRequest', 'MergePullRequest', 'ClosePullRequest', 'UpdatePullRequest']) schemas[`${mutation}Payload`] = { pullRequest: f('PullRequest'), clientMutationId: f('String') };
schemas.AddCommentPayload = { commentEdge: f('IssueCommentEdge'), clientMutationId: f('String') };
schemas.SearchResultItem = { id: f('ID!') };

type Node = { type: string; value: any; repo?: Repo };
const node = (type: string, value: any, repo?: Repo): Node | null => value == null ? null : ({ type, value, repo });
const baseType = (type: string) => type.replace(/[\[\]!]/g, '');
function typeInfo(type: string): Node {
  if (type.endsWith('!')) return node('__Type', { kind: 'NON_NULL', name: null, ofType: typeInfo(type.slice(0, -1)) })!;
  if (type.startsWith('[')) return node('__Type', { kind: 'LIST', name: null, ofType: typeInfo(type.slice(1, -1)) })!;
  return node('__Type', { kind: enums[type] ? 'ENUM' : inputs[type] ? 'INPUT_OBJECT' : type === 'Node' ? 'INTERFACE' : type === 'SearchResultItem' ? 'UNION' : schemas[type] ? 'OBJECT' : 'SCALAR', name: type, ofType: null })!;
}
function knownType(type: string) { return !!schemas[type] || !!inputs[type] || !!enums[type] || ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime'].includes(type); }
function coerce(value: any, type: string, path: string): any {
  if (type.endsWith('!')) { if (value == null) throw new Error(`${path} of type ${type} is required.`); return coerce(value, type.slice(0, -1), path); }
  if (value == null) return value;
  if (type.startsWith('[')) { const inner = type.slice(1, -1); return (Array.isArray(value) ? value : [value]).map((item, i) => coerce(item, inner, `${path}[${i}]`)); }
  if (inputs[type]) {
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an input object of type ${type}.`);
    const out: Record<string, any> = {};
    for (const name of Object.keys(value)) if (!inputs[type][name]) throw new Error(`Field ${name} is not defined by input type ${type}.`);
    for (const [name, fieldType] of Object.entries(inputs[type])) { const field = coerce(value[name], fieldType, `${path}.${name}`); if (field !== undefined) out[name] = field; }
    return out;
  }
  if (enums[type]) { if (!enums[type].includes(value)) throw new Error(`${path} has an invalid ${type} value.`); return value; }
  if (type === 'ID') { if (typeof value !== 'string' && !Number.isInteger(value)) throw new Error(`${path} must be an ID.`); return String(value); }
  if (type === 'String' || type === 'DateTime') { if (typeof value !== 'string') throw new Error(`${path} must be a string.`); return value; }
  if (type === 'Boolean') { if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean.`); return value; }
  if (type === 'Int') { if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new Error(`${path} must be a 32-bit integer.`); return value; }
  if (type === 'Float') { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a finite number.`); return value; }
  throw new Error(`Unknown input type ${type}.`);
}
function cursor(index: number) { return Buffer.from(`cursor:${index}`).toString('base64'); }
function indexOfCursor(value: any): number | undefined { if (typeof value !== 'string') return undefined; const text = Buffer.from(value, 'base64').toString(); if (!text.startsWith('cursor:')) throw new Error('Invalid cursor'); const index = Number(text.slice(7)); if (!Number.isInteger(index) || index < 0) throw new Error('Invalid cursor'); return index; }
function connection(type: string, values: (Node | null)[], args: any): Node {
  const first = args.first, last = args.last;
  for (const count of [first, last]) if (count !== undefined && count !== null && (!Number.isInteger(count) || count < 0)) throw new Error('Pagination count must be a nonnegative integer');
  const after = indexOfCursor(args.after), before = indexOfCursor(args.before);
  let start = after === undefined ? 0 : Math.min(values.length, after + 1), end = before === undefined ? values.length : Math.min(values.length, before);
  end = Math.max(start, end);
  if (first !== undefined && first !== null) end = Math.min(end, start + Math.min(first, 100));
  if (last !== undefined && last !== null) start = Math.max(start, end - Math.min(last, 100));
  const selected = values.slice(start, end), edges = selected.map((value, i) => node(`${type}Edge`, { node: value, cursor: cursor(start + i) }));
  return node(`${type}Connection`, { nodes: selected, edges, totalCount: values.length, pageInfo: node('PageInfo', { hasNextPage: end < values.length, hasPreviousPage: start > 0, startCursor: selected.length ? cursor(start) : null, endCursor: selected.length ? cursor(end - 1) : null }) })!;
}
function nodeById(store: Store, id: any): Node | null {
  if (typeof id !== 'string') return null;
  const value = store.nodes.get(id);
  if (!value) {
    if (id === store.user().node_id) return node('User', store.user());
    const decoded = Buffer.from(id, 'base64').toString(), first = decoded.indexOf(':'), kind = decoded.slice(0, first), rest = decoded.slice(first + 1);
    if (kind === 'Commit') { for (const repo of store.repos.values()) if (repo.owner.login.toLowerCase() === store.viewer.toLowerCase() && repo.objects.get(rest)?.type === 'commit') return node('Commit', { oid: rest }, repo); }
    if (kind === 'Ref' || kind === 'Label') {
      const colon = rest.indexOf(':'), repoId = Number(rest.slice(0, colon)), key = rest.slice(colon + 1), repo = [...store.repos.values()].find(repo => repo.id === repoId && repo.owner.login.toLowerCase() === store.viewer.toLowerCase());
      if (!repo) return null;
      if (kind === 'Label') return node('Label', repo.labels.get(key), repo);
      const oid = repo.refs.get(key), prefix = key.startsWith('refs/heads/') ? 'refs/heads/' : key.startsWith('refs/tags/') ? 'refs/tags/' : key.slice(0, key.lastIndexOf('/') + 1);
      return oid ? node('Ref', { name: key.slice(prefix.length), prefix, oid }, repo) : null;
    }
    return null;
  }
  if (value.refs instanceof Map) return store.repos.get(value.name.toLowerCase()) === value && value.owner.login.toLowerCase() === store.viewer.toLowerCase() ? node('Repository', value, value) : null;
  if (store.repos.get(value.repo.name.toLowerCase()) !== value.repo || value.repo.owner.login.toLowerCase() !== store.viewer.toLowerCase()) return null;
  return value.issue ? node('Issue', value.issue, value.repo) : value.pull ? node('PullRequest', value.pull, value.repo) : value.comment ? node('IssueComment', value.comment, value.repo) : null;
}
function ordered(values: any[], args: any) {
  let result = values;
  if (args.states) { const states = new Set(Array.isArray(args.states) ? args.states : [args.states]); result = result.filter(v => states.has(v.merged ? 'MERGED' : String(v.state).toUpperCase())); }
  if (args.labels) result = result.filter(v => args.labels.every((name: string) => (v.labels ?? []).some((l: any) => l.name === name)));
  const key = args.orderBy?.field === 'UPDATED_AT' ? 'updated_at' : args.orderBy?.field === 'COMMENTS' ? 'comments' : 'created_at';
  const sign = args.orderBy?.direction === 'DESC' ? -1 : 1;
  return result.slice().sort((a, b) => sign * (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : a.number - b.number));
}

function resolve(store: Store, parent: Node, name: string, args: any): any {
  const { type, value: v, repo: r } = parent;
  if (name === '__typename') return type;
  if (type === 'Query') {
    if (name === 'viewer') return node('User', store.user());
    if (name === 'repository') { try { const repo = store.getRepo(args.owner, args.name); return node('Repository', repo, repo); } catch (err) { if (err instanceof ApiError && err.status === 404) return null; throw err; } }
    if (name === 'node') return nodeById(store, args.id);
    if (name === 'nodes') return args.ids.map((id: string) => nodeById(store, id));
    if (name === '__type') return knownType(args.name) ? typeInfo(args.name) : null;
    if (name === '__schema') return node('__Schema', {});
    if (name === 'search') {
      const terms = String(args.query).split(/\s+/), qualifiers = new Map<string, string>(), text: string[] = [];
      for (const term of terms) { const colon = term.indexOf(':'); if (colon > 0) qualifiers.set(term.slice(0, colon), term.slice(colon + 1)); else text.push(term.toLowerCase()); }
      let repos = [...store.repos.values()];
      if (qualifiers.has('repo')) repos = repos.filter(repo => `${repo.owner.login}/${repo.name}`.toLowerCase() === qualifiers.get('repo')!.toLowerCase());
      if (args.type === 'REPOSITORY') return connection('SearchResultItem', repos.filter(repo => text.every(t => `${repo.name} ${repo.description}`.toLowerCase().includes(t))).map(repo => node('Repository', repo, repo)), args);
      const items: Node[] = [];
      for (const repo of repos) for (const [kind, list] of [['Issue', repo.issues], ['PullRequest', repo.pulls]] as const) for (const issue of list.values()) {
        if (qualifiers.get('is') === 'pr' && kind !== 'PullRequest' || qualifiers.get('is') === 'issue' && kind !== 'Issue') continue;
        if (['open', 'closed'].includes(qualifiers.get('state') ?? qualifiers.get('is') ?? '') && issue.state !== (qualifiers.get('state') ?? qualifiers.get('is'))) continue;
        if (text.every(t => `${issue.title} ${issue.body}`.toLowerCase().includes(t))) items.push(node(kind, issue, repo)!);
      }
      return connection('SearchResultItem', items, args);
    }
  }
  if (type === 'Mutation') {
    const input = args.input;
    if (!input || typeof input !== 'object') throw new Error('Mutation input is required');
    const payload = (type: string, key: string, entity: Node | null) => node(type, { [key]: entity, clientMutationId: input.clientMutationId ?? null });
    const find = (id: string, expected: string): Node => { const result = nodeById(store, id); if (!result || result.type !== expected) throw new Error(`Invalid ${expected} ID`); return result; };
    if (name === 'createIssue') {
      const repo = find(input.repositoryId, 'Repository').value as Repo;
      const labels = input.labelIds?.map((id: string) => {
        const label = [...repo.labels.values()].find(label => (label.node_id ?? Buffer.from(`Label:${repo.id}:${label.name}`).toString('base64')) === id);
        if (!label) throw new Error('Invalid Label ID');
        return label.name;
      });
      return payload('CreateIssuePayload', 'issue', node('Issue', store.createIssue(repo, { ...input, labels }), repo));
    }
    if (name === 'closeIssue' || name === 'reopenIssue' || name === 'updateIssue') { const target = find(input.issueId ?? input.id, 'Issue'); const updated = store.updateIssue(target.repo!, target.value.number, name === 'updateIssue' ? input : { state: name === 'closeIssue' ? 'closed' : 'open' }); return payload(name[0].toUpperCase() + name.slice(1) + 'Payload', 'issue', node('Issue', updated, target.repo)); }
    if (name === 'createPullRequest') { const repo = find(input.repositoryId, 'Repository').value as Repo; return payload('CreatePullRequestPayload', 'pullRequest', node('PullRequest', store.createPull(repo, { ...input, head: input.headRefName, base: input.baseRefName }), repo)); }
    if (name === 'mergePullRequest' || name === 'closePullRequest' || name === 'updatePullRequest') { const target = find(input.pullRequestId ?? input.id, 'PullRequest'); if (name === 'mergePullRequest') store.mergePull(target.repo!, target.value.number, { commit_title: input.commitHeadline }); else store.updateIssue(target.repo!, target.value.number, name === 'closePullRequest' ? { state: 'closed' } : input); return payload(name[0].toUpperCase() + name.slice(1) + 'Payload', 'pullRequest', target); }
    if (name === 'addComment') { const target = nodeById(store, input.subjectId); if (!target?.repo || !['Issue', 'PullRequest'].includes(target.type)) throw new Error('Invalid comment subject ID'); const comment = store.addComment(target.repo, target.value.number, input.body); return payload('AddCommentPayload', 'commentEdge', node('IssueCommentEdge', { node: node('IssueComment', comment, target.repo), cursor: cursor(comment.id) })); }
  }
  if (type === 'Repository') {
    if (name === 'id') return v.node_id;
    if (name === 'databaseId') return v.id;
    if (name === 'nameWithOwner') return `${v.owner.login}/${v.name}`;
    if (name === 'owner') return node('User', { ...store.user(), login: v.owner.login });
    if (name === 'isPrivate') return v.private;
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'defaultBranchRef') { const oid = resolveRef(v); return oid ? node('Ref', { name: v.default_branch, prefix: 'refs/heads/', oid }, v) : null; }
    if (name === 'ref') {
      const oid = resolveRef(v, args.qualifiedName), prefix = args.qualifiedName.startsWith('refs/heads/') ? 'refs/heads/' : args.qualifiedName.startsWith('refs/tags/') ? 'refs/tags/' : args.qualifiedName.startsWith('refs/') ? args.qualifiedName.slice(0, args.qualifiedName.lastIndexOf('/') + 1) : '';
      return oid ? node('Ref', { name: args.qualifiedName.slice(prefix.length), prefix, oid }, v) : null;
    }
    if (name === 'refs') { const refs = [...v.refs].filter(([ref]) => ref.startsWith(args.refPrefix)).sort(([a], [b]) => a.localeCompare(b)); return connection('Ref', refs.map(([ref, oid]) => node('Ref', { name: ref.slice(args.refPrefix.length), prefix: args.refPrefix, oid }, v)), args); }
    if (name === 'issue') return node('Issue', v.issues.get(args.number), v);
    if (name === 'issues') return connection('Issue', ordered([...v.issues.values()], args).map(i => node('Issue', i, v)), args);
    if (name === 'pullRequest') return node('PullRequest', v.pulls.get(args.number), v);
    if (name === 'pullRequests') { let pulls = [...v.pulls.values()]; if (args.headRefName) pulls = pulls.filter(p => p.head.ref === args.headRefName); if (args.baseRefName) pulls = pulls.filter(p => p.base.ref === args.baseRefName); return connection('PullRequest', ordered(pulls, args).map(p => node('PullRequest', p, v)), args); }
  }
  if (type === 'User') {
    if (name === 'id') return v.node_id ?? 'VXNlcjox';
    if (name === 'databaseId') return v.id ?? 1;
    if (name === 'email') return v.email ?? '';
    if (name === 'repositories') return connection('Repository', [...store.repos.values()].map(repo => node('Repository', repo, repo)), args);
  }
  if (type === 'Issue' || type === 'PullRequest' || type === 'IssueComment') {
    if (name === 'id') return v.node_id;
    if (name === 'databaseId') return v.id;
    if (name === 'state') return type === 'PullRequest' && v.merged ? 'MERGED' : v.state.toUpperCase();
    if (name === 'createdAt') return v.created_at;
    if (name === 'updatedAt') return v.updated_at;
    if (name === 'closed') return v.state === 'closed';
    if (name === 'author') return node('User', v.user ?? store.user());
    if (name === 'repository') return node('Repository', r, r);
    if (name === 'headRefName') return v.head.ref;
    if (name === 'baseRefName') return v.base.ref;
    if (name === 'headRefOid') return resolveRef(r!, v.head.ref);
    if (name === 'baseRefOid') return resolveRef(r!, v.base.ref);
    if (name === 'mergeable') { try { store.mergedFiles(r!, v, false); return 'MERGEABLE'; } catch { return 'CONFLICTING'; } }
    if (name === 'mergedAt') return v.merged_at;
    if (name === 'files') return connection('PullRequestChangedFile', store.pullFiles(r!, v).map(file => node('PullRequestChangedFile', { ...file, changeType: file.status.toUpperCase() })), args);
    if (name === 'comments') return connection('IssueComment', (v.commentList ?? []).map((c: any) => node('IssueComment', c, r)), args);
    if (name === 'labels') return connection('Label', (v.labels ?? []).map((label: any) => node('Label', label, r)), args);
  }
  if (type === 'Ref') {
    if (name === 'id') return Buffer.from(`Ref:${r!.id}:${v.prefix}${v.name}`).toString('base64');
    if (name === 'target') return node('Commit', { oid: v.oid }, r);
  }
  if (type === 'Commit') { if (name === 'id') return Buffer.from(`Commit:${v.oid}`).toString('base64'); if (name === 'message') { const data = r!.objects.get(v.oid)?.data.toString() ?? ''; return data.slice(data.indexOf('\n\n') + 2); } }
  if (type === 'Label' && name === 'id') return v.node_id ?? Buffer.from(`Label:${r?.id}:${v.name}`).toString('base64');
  if (type === '__Schema') {
    if (name === 'queryType') return typeInfo('Query');
    if (name === 'mutationType') return typeInfo('Mutation');
    if (name === 'subscriptionType') return null;
    if (name === 'types') return [...new Set([...Object.keys(schemas), ...Object.keys(inputs), ...Object.keys(enums), 'String', 'ID', 'Int', 'Float', 'Boolean', 'DateTime'])].sort().map(typeInfo);
    if (name === 'directives') return ['skip', 'include'].map(name => node('__Directive', { name, locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [node('__InputValue', { name: 'if', type: typeInfo('Boolean!'), defaultValue: null })], isRepeatable: false }));
  }
  if (type === '__Type') {
    const schema = schemas[v.name];
    if (name === 'fields') return v.kind === 'OBJECT' || v.kind === 'INTERFACE' ? Object.entries(schema ?? {}).map(([name, field]) => node('__Field', { name, type: typeInfo(field.type), args: Object.entries(field.args ?? {}).map(([name, type]) => node('__InputValue', { name, type: typeInfo(type), defaultValue: null })), isDeprecated: false, deprecationReason: null })) : null;
    if (name === 'enumValues') return enums[v.name]?.map(name => node('__EnumValue', { name, isDeprecated: false, deprecationReason: null })) ?? null;
    if (name === 'inputFields') return inputs[v.name] ? Object.entries(inputs[v.name]).map(([name, type]) => node('__InputValue', { name, type: typeInfo(type), defaultValue: null })) : null;
    if (name === 'interfaces') return ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User', 'Ref', 'Commit', 'Label'].includes(v.name) ? [typeInfo('Node')] : [];
    if (name === 'possibleTypes') return v.name === 'Node' ? ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User', 'Ref', 'Commit', 'Label'].map(typeInfo) : v.name === 'SearchResultItem' ? ['Repository', 'Issue', 'PullRequest', 'User'].map(typeInfo) : null;
    if (name === 'isOneOf') return false;
  }
  if ((type === '__InputValue' || type === '__EnumValue') && name === 'isDeprecated') return false;
  return v[name] ?? null;
}

function typeMatches(actual: string, condition: string | undefined) { return !condition || actual === condition || condition === 'Node' && ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User', 'Ref', 'Commit', 'Label'].includes(actual) || condition === 'SearchResultItem' && ['Repository', 'Issue', 'PullRequest', 'User'].includes(actual); }
function expanded(selections: Selection[], doc: Document, type: string, variables: Record<string, any>, stack = new Set<string>()): Selection[] {
  const out: Selection[] = [];
  for (const selection of selections) {
    if (!included(selection.directives, variables)) continue;
    if (selection.fragment) {
      if (stack.has(selection.fragment)) throw new Error(`Cyclic fragment ${selection.fragment}`);
      const fragment = doc.fragments.get(selection.fragment); if (!fragment) throw new Error(`Unknown fragment ${selection.fragment}`);
      if (typeMatches(type, fragment.condition) && included(fragment.directives, variables)) out.push(...expanded(fragment.children, doc, type, variables, new Set([...stack, selection.fragment])));
    } else if (!selection.name) { if (typeMatches(type, selection.condition)) out.push(...expanded(selection.children ?? [], doc, type, variables, stack)); }
    else out.push(selection);
  }
  return out;
}
function validate(selections: Selection[], doc: Document, type: string, variables: Record<string, any>, errors: any[], stack = new Set<string>()) {
  for (const selection of selections) {
    if (selection.fragment) { if (stack.has(selection.fragment)) { errors.push({ message: `Cyclic fragment ${selection.fragment}` }); continue; } const fragment = doc.fragments.get(selection.fragment); if (!fragment) { errors.push({ message: `Unknown fragment ${selection.fragment}` }); continue; } validate(fragment.children, doc, fragment.condition, variables, errors, new Set([...stack, selection.fragment])); continue; }
    if (!selection.name) { validate(selection.children ?? [], doc, selection.condition ?? type, variables, errors, stack); continue; }
    const field = selection.name === '__typename' ? f('String!') : schemas[type]?.[selection.name];
    if (!field) { errors.push({ message: `Cannot query field "${selection.name}" on type "${type}".` }); continue; }
    const args = argumentsOf(selection.args, variables);
    for (const [name, value] of Object.entries(args)) if (!field.args?.[name]) errors.push({ message: `Unknown argument "${name}" on field "${type}.${selection.name}".` });
    for (const [name, argType] of Object.entries(field.args ?? {})) { try { coerce(args[name], argType, `Argument "${name}" of field "${selection.name}"`); } catch (err) { errors.push({ message: err instanceof Error ? err.message : String(err) }); } }
    const next = baseType(field.type), composite = !!schemas[next];
    if (composite && !selection.children) errors.push({ message: `Field "${selection.name}" of type "${field.type}" requires a selection set.` });
    if (!composite && selection.children) errors.push({ message: `Field "${selection.name}" must not have a selection set.` });
    if (selection.children && composite) validate(selection.children, doc, next, variables, errors, stack);
  }
}
function validateResponseNames(selections: Selection[], doc: Document, type: string, variables: Record<string, any>, errors: any[]) {
  // Validate all response-name groups before executing any mutation. Abstract
  // types are checked separately for each possible concrete runtime type.
  const concrete = type === 'Node' ? ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User', 'Ref', 'Commit', 'Label'] : type === 'SearchResultItem' ? ['Repository', 'Issue', 'PullRequest', 'User'] : [type];
  for (const actual of concrete) {
    const groups = new Map<string, Selection>();
    for (const selection of expanded(selections, doc, actual, variables)) {
      const key = selection.alias ?? selection.name!, previous = groups.get(key);
      const sameArguments = (left: any, right: any): boolean => {
        const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value;
        return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
      };
      if (!previous) groups.set(key, { ...selection, children: selection.children?.slice() });
      else if (previous.name !== selection.name || !sameArguments(argumentsOf(previous.args, variables), argumentsOf(selection.args, variables))) errors.push({ message: `Fields with response name "${key}" conflict.` });
      else if (selection.children) previous.children = [...(previous.children ?? []), ...selection.children];
    }
    for (const selection of groups.values()) if (selection.children) {
      const field = schemas[actual]?.[selection.name!];
      if (field) validateResponseNames(selection.children, doc, baseType(field.type), variables, errors);
    }
  }
}
function execute(store: Store, parent: Node | null, selections: Selection[], doc: Document, variables: Record<string, any>, errors: any[], path: (string | number)[] = []): any {
  if (!parent) return null;
  const result: Record<string, any> = {};
  const fields = new Map<string, Selection>();
  for (const selection of expanded(selections, doc, parent.type, variables)) {
    const key = selection.alias ?? selection.name!;
    const previous = fields.get(key);
    if (!previous) fields.set(key, { ...selection, children: selection.children?.slice() });
    else if (previous.name !== selection.name || JSON.stringify(argumentsOf(previous.args, variables)) !== JSON.stringify(argumentsOf(selection.args, variables))) errors.push({ message: `Fields with response name "${key}" conflict.`, path: [...path, key] });
    else if (selection.children) previous.children = [...(previous.children ?? []), ...selection.children];
  }
  for (const [key, selection] of fields) {
    try {
      const args = argumentsOf(selection.args, variables), definition = schemas[parent.type]?.[selection.name!];
      for (const [name, type] of Object.entries(definition?.args ?? {})) if (args[name] !== undefined) args[name] = coerce(args[name], type, `Argument ${name}`);
      const value = resolve(store, parent, selection.name!, args);
      const serialize = (value: any, nextPath: (string | number)[]): any => Array.isArray(value) ? value.map((v, i) => serialize(v, [...nextPath, i])) : selection.children ? execute(store, value, selection.children, doc, variables, errors, nextPath) : value;
      const next = serialize(value, [...path, key]);
      if (result[key] && next && typeof result[key] === 'object' && !Array.isArray(next)) Object.assign(result[key], next); else result[key] = next;
    } catch (err) { result[key] = null; errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] }); }
  }
  return result;
}

const documents = new Map<string, Document>();
function run(store: Store, body: any): any {
  if (!body || typeof body.query !== 'string') return { errors: [{ message: 'The request must include a GraphQL query string.' }] };
  try {
    let doc = documents.get(body.query); if (!doc) { doc = new Parser(body.query).document(); if (documents.size >= 512) documents.delete(documents.keys().next().value!); documents.set(body.query, doc); }
    const operation = body.operationName ? doc.operations.find(op => op.name === body.operationName) : doc.operations.length === 1 ? doc.operations[0] : undefined;
    if (!operation) throw new Error(body.operationName ? `Unknown operation ${body.operationName}` : 'An operationName is required for a document with multiple operations');
    if (operation.kind === 'subscription') throw new Error('Subscriptions are not supported');
    if (body.variables != null && (typeof body.variables !== 'object' || Array.isArray(body.variables))) throw new Error('Variables must be an object');
    const variables = { ...(body.variables ?? {}) };
    for (const [name, value] of Object.entries(operation.defaults)) if (variables[name] === undefined) variables[name] = evaluate(value, variables);
    const errors: any[] = [];
    for (const [name, type] of Object.entries(operation.variables)) { try { variables[name] = coerce(variables[name], type, `Variable "$${name}"`); } catch (err) { errors.push({ message: err instanceof Error ? err.message : String(err) }); } }
    const type = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    validate(operation.children, doc, type, variables, errors);
    if (!errors.length) validateResponseNames(operation.children, doc, type, variables, errors);
    if (errors.length) return { errors };
    const data = execute(store, node(type, {})!, operation.children, doc, variables, errors);
    return errors.length ? { data, errors } : { data };
  } catch (err) { return { errors: [{ message: err instanceof Error ? err.message : String(err) }] }; }
}
export function graphql(store: Store, body: any): any { return Array.isArray(body) ? body.map(item => run(store, item)) : run(store, body); }
