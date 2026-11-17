import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { ApiError, ZERO, isAncestor, parseCommit, parseTree } from './domain.mjs';
const FLUSH = Buffer.from('0000');
const DELIM = Buffer.from('0001');
const MAX_PAYLOAD = 65515;
const TYPES = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag'
};
const TYPE_NUMBER = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4
};
const sha1 = data => createHash('sha1').update(data).digest();
const hashObject = object => createHash('sha1').update(`${object.type} ${object.data.length}\0`).update(object.data).digest('hex');
const pkt = value => {
  const data = typeof value === 'string' ? Buffer.from(value) : value;
  if (data.length > 65516) throw new Error('Packet too large');
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
};
function readPackets(body, stopAtFlush = false) {
  const packets = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new ApiError(400, 'Truncated pkt-line');
    const hex = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw new ApiError(400, 'Invalid pkt-line length');
    const size = parseInt(hex, 16);
    offset += 4;
    if (size < 4) {
      if (size === 3) throw new ApiError(400, 'Invalid pkt-line control');
      const kind = size === 0 ? 'flush' : size === 1 ? 'delim' : 'end';
      packets.push({
        kind,
        data: Buffer.alloc(0)
      });
      if (stopAtFlush && size === 0) break;
      continue;
    }
    if (size > 65520 || offset + size - 4 > body.length) throw new ApiError(400, 'Truncated or oversized pkt-line');
    packets.push({
      kind: 'data',
      data: body.subarray(offset, offset + size - 4)
    });
    offset += size - 4;
  }
  return {
    packets,
    offset
  };
}
function applyDelta(base, delta) {
  let p = 0;
  const integer = () => {
    let value = 0,
      multiplier = 1,
      byte;
    do {
      if (p >= delta.length || multiplier > 2 ** 49) throw new Error('Invalid delta integer');
      byte = delta[p++];
      value += (byte & 127) * multiplier;
      multiplier *= 128;
    } while (byte & 128);
    return value;
  };
  if (integer() !== base.length) throw new Error('Delta base size mismatch');
  const length = integer();
  if (length > 64 * 1024 * 1024) throw new Error('Delta object too large');
  const result = Buffer.allocUnsafe(length);
  let target = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 128) {
      let offset = 0,
        size = 0;
      for (let i = 0; i < 4; i++) if (op & 1 << i) {
        if (p >= delta.length) throw new Error('Truncated delta copy');
        offset += delta[p++] * 2 ** (8 * i);
      }
      for (let i = 0; i < 3; i++) if (op & 1 << i + 4) {
        if (p >= delta.length) throw new Error('Truncated delta size');
        size += delta[p++] * 2 ** (8 * i);
      }
      if (size === 0) size = 65536;
      if (offset + size > base.length || target + size > length) throw new Error('Invalid delta copy range');
      base.copy(result, target, offset, offset + size);
      target += size;
    } else {
      if (op === 0 || p + op > delta.length || target + op > length) throw new Error('Invalid delta literal');
      delta.copy(result, target, p, p + op);
      p += op;
      target += op;
    }
  }
  if (target !== length) throw new Error('Delta output size mismatch');
  return result;
}
/** PACKs carry consecutive zlib streams. bytesWritten is the consumed input, not output length. */
export function readPack(body, existing) {
  if (body.length < 32 || body.toString('ascii', 0, 4) !== 'PACK') throw new Error('Invalid PACK header');
  const trailer = body.length - 20;
  if (!sha1(body.subarray(0, trailer)).equals(body.subarray(trailer))) throw new Error('PACK checksum mismatch');
  const version = body.readUInt32BE(4),
    count = body.readUInt32BE(8);
  if (version !== 2 && version !== 3 || count > 1000000) throw new Error('Invalid PACK version or object count');
  const entries = [],
    byOffset = new Map(),
    objects = new Map();
  let p = 12;
  for (let index = 0; index < count; index++) {
    const start = p;
    if (p >= trailer) throw new Error('Truncated PACK object');
    let byte = body[p++],
      type = byte >> 4 & 7,
      size = byte & 15,
      multiplier = 16;
    while (byte & 128) {
      if (p >= trailer || multiplier > 2 ** 49) throw new Error('Invalid PACK size');
      byte = body[p++];
      size += (byte & 127) * multiplier;
      multiplier *= 128;
    }
    if (size > 64 * 1024 * 1024) throw new Error('PACK object too large');
    let baseOffset, baseOid;
    if (type === 6) {
      if (p >= trailer) throw new Error('Truncated OFS_DELTA');
      byte = body[p++];
      let distance = byte & 127;
      while (byte & 128) {
        if (p >= trailer || distance > 2 ** 49) throw new Error('Invalid OFS_DELTA');
        byte = body[p++];
        distance = (distance + 1) * 128 + (byte & 127);
      }
      baseOffset = start - distance;
      if (!byOffset.has(baseOffset)) throw new Error('Unknown OFS_DELTA base');
    } else if (type === 7) {
      if (p + 20 > trailer) throw new Error('Truncated REF_DELTA');
      baseOid = body.subarray(p, p + 20).toString('hex');
      p += 20;
    } else if (!TYPES[type]) throw new Error('Invalid PACK object type');
    const inflated = inflateSync(body.subarray(p, trailer), {
      info: true,
      maxOutputLength: Math.max(1, size),
      chunkSize: Math.max(64, Math.min(16384, size + 1))
    });
    if (inflated.buffer.length !== size || !inflated.engine.bytesWritten) throw new Error('PACK object size mismatch');
    p += inflated.engine.bytesWritten;
    if (p > trailer) throw new Error('Truncated PACK stream');
    const e = {
      offset: start,
      type,
      bytes: inflated.buffer,
      baseOffset,
      baseOid
    };
    if (TYPES[type]) {
      e.object = {
        type: TYPES[type],
        data: e.bytes
      };
      e.oid = hashObject(e.object);
      objects.set(e.oid, e.object);
    }
    entries.push(e);
    byOffset.set(start, e);
  }
  if (p !== trailer) throw new Error('Unexpected PACK trailing bytes');
  let unresolved = entries.filter(e => !e.object);
  while (unresolved.length) {
    let resolved = 0;
    const next = [];
    for (const e of unresolved) {
      const base = e.baseOffset !== undefined ? byOffset.get(e.baseOffset)?.object : objects.get(e.baseOid) ?? existing.get(e.baseOid);
      if (!base) {
        next.push(e);
        continue;
      }
      e.object = {
        type: base.type,
        data: applyDelta(base.data, e.bytes)
      };
      e.oid = hashObject(e.object);
      objects.set(e.oid, e.object);
      resolved++;
    }
    if (!resolved) throw new Error('Missing delta base');
    unresolved = next;
  }
  return objects;
}
function objectHeader(type, length) {
  const bytes = [];
  let n = Math.floor(length / 16),
    first = type << 4 | length & 15;
  if (n) first |= 128;
  bytes.push(first);
  while (n) {
    const byte = n % 128;
    n = Math.floor(n / 128);
    bytes.push(byte | (n ? 128 : 0));
  }
  return Buffer.from(bytes);
}
export function writePack(objects) {
  const entries = [...objects],
    header = Buffer.allocUnsafe(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const parts = [header];
  for (const o of entries) {
    const number = TYPE_NUMBER[o.type];
    if (!number) throw new Error('Unknown object type');
    parts.push(objectHeader(number, o.data.length), deflateSync(o.data, {
      level: 1
    }));
  }
  const bytes = Buffer.concat(parts);
  return Buffer.concat([bytes, sha1(bytes)]);
}
function tagTarget(object) {
  if (object.type !== 'tag') return;
  const first = object.data.toString('utf8').split('\n').find(line => line.startsWith('object '));
  return first?.slice(7);
}
function peel(repo, id) {
  const seen = new Set();
  while (!seen.has(id)) {
    seen.add(id);
    const object = repo.objects.get(id);
    if (!object) break;
    const next = tagTarget(object);
    if (!next) break;
    id = next;
  }
  return id;
}
function references(repo) {
  const refs = [...repo.refs].sort(([a], [b]) => a.localeCompare(b)).map(([name, oid]) => ({
    name,
    oid
  }));
  const tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
  if (tip) refs.unshift({
    name: 'HEAD',
    oid: tip
  });
  return refs;
}
function advertise(repo, service, v2) {
  if (v2) return Buffer.concat([pkt('version 2\n'), pkt('agent=NativeForge/1\n'), pkt('ls-refs=unborn\n'), pkt('fetch=shallow\n'), pkt('object-format=sha1\n'), FLUSH]);
  const caps = service === 'git-receive-pack' ? 'report-status side-band-64k delete-refs ofs-delta agent=NativeForge/1' : `side-band-64k ofs-delta shallow thin-pack multi_ack_detailed symref=HEAD:refs/heads/${repo.default_branch} agent=NativeForge/1`;
  const refs = references(repo),
    lines = [pkt(`# service=${service}\n`), FLUSH];
  if (!refs.length) lines.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  refs.forEach((ref, i) => {
    lines.push(pkt(`${ref.oid} ${ref.name}${i === 0 ? '\0' + caps : ''}\n`));
    const peeled = peel(repo, ref.oid);
    if (peeled !== ref.oid) lines.push(pkt(`${peeled} ${ref.name}^{}\n`));
  });
  lines.push(FLUSH);
  return Buffer.concat(lines);
}
function lsRefs(repo, lines) {
  const prefixes = lines.filter(s => s.startsWith('ref-prefix ')).map(s => s.slice(11)),
    keep = name => !prefixes.length || prefixes.some(p => name.startsWith(p)),
    parts = [];
  for (const ref of references(repo)) {
    if (!keep(ref.name)) continue;
    let suffix = '';
    if (ref.name === 'HEAD' && lines.includes('symrefs')) suffix += ` symref-target:refs/heads/${repo.default_branch}`;
    const peeled = peel(repo, ref.oid);
    if (lines.includes('peel') && peeled !== ref.oid) suffix += ` peeled:${peeled}`;
    parts.push(pkt(`${ref.oid} ${ref.name}${suffix}\n`));
  }
  if (!repo.refs.has(`refs/heads/${repo.default_branch}`) && lines.includes('unborn') && keep('HEAD')) parts.push(pkt(`unborn HEAD${lines.includes('symrefs') ? ` symref-target:refs/heads/${repo.default_branch}` : ''}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Closure for haves stops at the client's shallow commits: their parents are not held. */
function closure(repo, starts, stops, depth = Infinity) {
  const ids = new Set(),
    boundary = new Set(),
    best = new Map(),
    pending = starts.map(id => [id, 1]);
  while (pending.length) {
    const [id, generation] = pending.pop();
    const object = repo.objects.get(id);
    if (!object) continue;
    if (object.type === 'commit') {
      const prior = best.get(id);
      if (prior !== undefined && prior <= generation) continue;
      best.set(id, generation);
    } else if (ids.has(id)) continue;
    ids.add(id);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      pending.push([commit.tree, generation]);
      if (commit.parents.length && (generation >= depth || stops.has(id))) boundary.add(id);else for (const parent of commit.parents) pending.push([parent, generation + 1]);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') pending.push([entry.oid, generation]);
    } else if (object.type === 'tag') {
      const target = tagTarget(object);
      if (target) pending.push([target, generation]);
    }
  }
  for (const [id, generation] of best) if (generation < depth && !stops.has(id)) boundary.delete(id);
  return {
    ids,
    boundary
  };
}
function sideband(data) {
  const out = [];
  for (let p = 0; p < data.length; p += MAX_PAYLOAD) out.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(p, p + MAX_PAYLOAD)])));
  return out;
}
function fetch(repo, lines, v2) {
  const ids = prefix => [...new Set(lines.filter(s => s.startsWith(prefix + ' ')).map(s => s.split(' ')[1]))];
  const wants = ids('want'),
    haves = ids('have'),
    shallow = new Set(ids('shallow')),
    depthLine = lines.find(s => s.startsWith('deepen ')),
    depth = depthLine ? Number(depthLine.slice(7)) : Infinity;
  if (depthLine && (!Number.isSafeInteger(depth) || depth < 1)) throw new ApiError(400, 'Invalid deepen value');
  for (const id of [...wants, ...haves, ...shallow]) if (!/^[0-9a-f]{40}$/i.test(id)) throw new ApiError(400, 'Invalid object id');
  for (const id of wants) if (!repo.objects.has(id)) throw new ApiError(400, `Unknown want ${id}`);
  const key = JSON.stringify([v2, lines.includes('done'), [...wants].sort(), [...haves].sort(), [...shallow].sort(), depth]);
  const cached = repo.packCache.get(key);
  if (cached) return cached;
  const held = closure(repo, haves, shallow).ids,
    selected = closure(repo, wants, depthLine ? new Set() : shallow, depth),
    objects = [...selected.ids].filter(id => !held.has(id)).map(id => repo.objects.get(id));
  const boundaries = [...selected.boundary].sort(),
    unshallow = [...shallow].filter(id => selected.ids.has(id) && !selected.boundary.has(id)).sort(),
    pack = writePack(objects),
    parts = [];
  if (v2) {
    if (!lines.includes('done')) {
      parts.push(pkt('acknowledgments\n'));
      const known = haves.filter(id => repo.objects.has(id));
      parts.push(...known.map(id => pkt(`ACK ${id}\n`)));
      if (!known.length) parts.push(pkt('NAK\n'));
      parts.push(pkt('ready\n'), DELIM);
    }
    if (boundaries.length || unshallow.length) {
      parts.push(pkt('shallow-info\n'), ...boundaries.map(id => pkt(`shallow ${id}\n`)), ...unshallow.map(id => pkt(`unshallow ${id}\n`)), DELIM);
    }
    parts.push(pkt('packfile\n'), ...sideband(pack), FLUSH);
  } else {
    parts.push(...boundaries.map(id => pkt(`shallow ${id}\n`)), ...unshallow.map(id => pkt(`unshallow ${id}\n`)));
    if (depthLine) parts.push(FLUSH);
    parts.push(pkt('NAK\n'), ...sideband(pack), FLUSH);
  }
  const result = Buffer.concat(parts);
  if (repo.packCache.size >= 32) repo.packCache.delete(repo.packCache.keys().next().value);
  repo.packCache.set(key, result);
  return result;
}
function validRef(ref) {
  return ref.startsWith('refs/') && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(ref) && !ref.includes('..') && !ref.includes('@{') && !ref.includes('//') && !ref.endsWith('/') && !ref.endsWith('.') && !ref.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'));
}
const validatedObjects = new WeakMap();
function connected(repo, id) {
  const validated = validatedObjects.get(repo) ?? new Set();
  validatedObjects.set(repo, validated);
  const stack = [id],
    seen = new Set();
  try {
    while (stack.length) {
      const oid = stack.pop();
      if (seen.has(oid) || validated.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object) return false;
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree, ...commit.parents);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) if (entry.mode !== '160000') stack.push(entry.oid);
      } else if (object.type === 'tag') {
        const target = tagTarget(object);
        if (!target) return false;
        stack.push(target);
      }
    }
  } catch {
    return false;
  }
  for (const oid of seen) validated.add(oid);
  return true;
}
function receive(repo, body, store) {
  const {
      packets,
      offset
    } = readPackets(body, true),
    data = packets.filter(p => p.kind === 'data').map(p => p.data.toString('utf8').replace(/\n$/, ''));
  if (!packets.length || packets.at(-1)?.kind !== 'flush') throw new ApiError(400, 'Missing command flush');
  let caps = [];
  const commands = data.map((line, i) => {
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      if (i !== 0) throw new ApiError(400, 'Capabilities only allowed on first command');
      caps = line.slice(nul + 1).split(' ');
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length !== 3 || !fields.slice(0, 2).every(x => /^[0-9a-f]{40}$/i.test(x)) || !validRef(fields[2])) throw new ApiError(400, 'Invalid receive-pack command');
    return {
      old: fields[0],
      next: fields[1],
      ref: fields[2]
    };
  });
  if (new Set(commands.map(command => command.ref)).size !== commands.length) throw new ApiError(400, 'Duplicate ref command');
  let unpack = 'ok';
  try {
    if (offset < body.length) {
      const objects = readPack(body.subarray(offset), repo.objects);
      for (const [oid, object] of objects) repo.objects.set(oid, object);
    } else if (commands.some(c => c.next !== ZERO)) throw new Error('Missing PACK');
  } catch (error) {
    unpack = (error instanceof Error ? error.message : 'Invalid PACK').replace(/[\r\n]/g, ' ');
  }
  const report = [pkt(`unpack ${unpack}\n`)];
  let changed = false;
  for (const command of commands) {
    let reason = '';
    const current = repo.refs.get(command.ref) ?? ZERO;
    if (unpack !== 'ok') reason = 'unpacker error';else if (current !== command.old) reason = 'stale old object id';else if (command.next !== ZERO && [...repo.refs.keys()].some(ref => ref !== command.ref && (ref.startsWith(command.ref + '/') || command.ref.startsWith(ref + '/')))) reason = 'ref namespace conflict';else if (command.next !== ZERO && !repo.objects.has(command.next)) reason = 'missing object';else if (command.next !== ZERO && command.ref.startsWith('refs/heads/') && repo.objects.get(command.next)?.type !== 'commit') reason = 'branch must point to a commit';else if (command.next !== ZERO && !connected(repo, command.next)) reason = 'missing object';else if (command.next !== ZERO && command.old !== ZERO && !isAncestor(repo, command.old, command.next)) reason = 'non-fast-forward';
    if (reason) report.push(pkt(`ng ${command.ref} ${reason}\n`));else {
      if (command.next === ZERO) repo.refs.delete(command.ref);else repo.refs.set(command.ref, command.next);
      report.push(pkt(`ok ${command.ref}\n`));
      changed = true;
    }
  }
  if (changed) store.touch(repo);
  report.push(FLUSH);
  const stream = Buffer.concat(report);
  return caps.includes('side-band-64k') ? Buffer.concat([...sideband(stream), FLUSH]) : stream;
}
export function handleGit(store, req, res, url, body) {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!match) return false;
  const repo = store.getRepo(decodeURIComponent(match[1]), decodeURIComponent(match[2])),
    route = match[3],
    service = route === 'info/refs' ? url.searchParams.get('service') : route;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new ApiError(400, 'Unknown Git service');
  const v2 = service === 'git-upload-pack' && String(req.headers['git-protocol'] ?? '').split(':').some(s => s.trim() === 'version=2');
  let response;
  if (route === 'info/refs') {
    if (req.method !== 'GET') throw new ApiError(405, 'Method Not Allowed');
    response = advertise(repo, service, v2);
    res.setHeader('content-type', `application/x-${service}-advertisement`);
  } else {
    if (req.method !== 'POST') throw new ApiError(405, 'Method Not Allowed');
    if (service === 'git-receive-pack') response = receive(repo, body, store);else {
      const lines = readPackets(body).packets.filter(p => p.kind === 'data').map(p => p.data.toString('utf8').replace(/\n$/, ''));
      const command = lines.find(s => s.startsWith('command='));
      if (v2 && command === 'command=ls-refs') response = lsRefs(repo, lines);else if (!v2 || command === 'command=fetch') response = fetch(repo, lines, v2);else throw new ApiError(400, 'Unsupported Git command');
    }
    res.setHeader('content-type', `application/x-${service}-result`);
  }
  res.setHeader('cache-control', 'no-cache');
  res.statusCode = 200;
  res.end(response);
  return true;
}
