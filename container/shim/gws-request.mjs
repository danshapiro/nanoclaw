#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const planPath = process.argv[2];
const stageDir = process.argv[3];
const args = process.argv.slice(4);

function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(2);
}

function canonical(value, maximum = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[\x21-\x7e]+$/.test(value);
}

function rootsFrom(value, fallback) {
  return (value || fallback)
    .split(':')
    .filter(Boolean)
    .map((root) => {
      try {
        return fs.realpathSync(root);
      } catch {
        return path.resolve(root);
      }
    });
}

function insideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

const outputRoots = rootsFrom(process.env.GWS_SHIM_READONLY_OUTPUT_ROOTS, '/workspace/agent:/workspace/outbox');
const inputRoots = rootsFrom(process.env.GWS_SHIM_READONLY_INPUT_ROOTS, '/workspace/agent:/workspace/outbox');

function parseOutputArgs(values) {
  let outputArg = null;
  const proxyArgs = [];
  const valueFlags = new Set([
    '--params',
    '--json',
    '--format',
    '--fields',
    '--filter',
    '--query',
    '--q',
    '--userId',
    '--user-id',
    '--fileId',
    '--file-id',
    '--documentId',
    '--document-id',
    '--spreadsheetId',
    '--spreadsheet-id',
    '--presentationId',
    '--presentation-id',
    '--calendarId',
    '--calendar-id',
    '--eventId',
    '--event-id',
    '--mimeType',
    '--mime-type',
    '--pageToken',
    '--page-token',
    '--pageSize',
    '--page-size',
    '--upload',
    '--upload-content-type',
    '--attach',
    '-a',
  ]);
  let parseOptions = true;
  for (let index = 0; index < values.length; index++) {
    const arg = values[index];
    let output = null;
    if (!parseOptions) {
      proxyArgs.push(arg);
      continue;
    }
    if (arg === '--') {
      parseOptions = false;
      proxyArgs.push(arg);
      continue;
    }
    if (valueFlags.has(arg)) {
      proxyArgs.push(arg);
      if (index + 1 < values.length) proxyArgs.push(values[++index]);
      continue;
    }
    if (arg === '-o' || arg === '--output') {
      if (index + 1 >= values.length) fail(`${arg} requires a path value`);
      output = values[++index];
    } else if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length);
    } else if (arg.startsWith('-o=')) {
      output = arg.slice('-o='.length);
    } else if (arg.startsWith('-o') && arg.length > 2) {
      fail('attached -oPATH output syntax is not supported; use -o PATH or --output PATH');
    }
    if (output !== null) {
      if (outputArg !== null) fail('multiple output paths were provided');
      if (output === '') fail('output path must not be empty');
      outputArg = output;
      continue;
    }
    proxyArgs.push(arg);
  }
  return { proxyArgs, outputArg };
}

function planOutput(outputArg) {
  if (outputArg === null) return null;
  const lexicalResolved = path.resolve(process.cwd(), outputArg);
  const parent = path.dirname(lexicalResolved);
  const basename = path.basename(lexicalResolved);
  if (!basename || basename === '.' || basename === '..') fail('output path must name a file');
  let parentReal;
  try {
    if (!fs.statSync(parent).isDirectory()) fail(`output parent path is not a directory: ${parent}`);
    parentReal = fs.realpathSync(parent);
  } catch {
    fail(`output parent directory does not exist: ${parent}`);
  }
  if (!outputRoots.some((root) => insideRoot(parentReal, root))) {
    fail(`output path ${lexicalResolved} is outside allowed output roots: ${outputRoots.join(':')}`);
  }
  const resolvedPath = path.join(parentReal, basename);
  try {
    const target = fs.lstatSync(resolvedPath);
    if (target.isSymbolicLink()) fail(`output target is a symlink: ${resolvedPath}`);
    fail(`output target already exists: ${resolvedPath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { requestedPath: outputArg, resolvedPath, parent: parentReal, basename };
}

function splitLongFlag(arg) {
  if (!arg.startsWith('--')) return ['', false];
  const value = arg.slice(2);
  const equals = value.indexOf('=');
  return equals < 0 ? [value, false] : [value.slice(0, equals), true];
}

function driveUploadSlots(values) {
  const positionals = [];
  let endOfFlags = false;
  for (let index = 2; index < values.length; index++) {
    const arg = values[index];
    if (endOfFlags) {
      positionals.push(index);
      continue;
    }
    if (arg === '--') {
      endOfFlags = true;
      continue;
    }
    const [name, inline] = splitLongFlag(arg);
    if (['parent', 'name', 'sanitize', 'format'].includes(name)) {
      if (!inline) {
        if (index + 1 >= values.length || values[index + 1].startsWith('-')) fail(`--${name} requires a value`);
        index++;
      }
    } else if (name === 'help' || arg === '-h') {
      continue;
    } else if (!name && !arg.startsWith('-')) {
      positionals.push(index);
    } else {
      fail(`unknown drive +upload flag ${arg}`);
    }
  }
  if (positionals.length !== 1) fail('drive +upload requires exactly one file');
  return [{ argIndex: positionals[0], prefix: '', contentType: 'application/octet-stream' }];
}

function gmailAttachmentSlots(values) {
  const slots = [];
  for (let index = 2; index < values.length; index++) {
    const arg = values[index];
    if (arg === '--upload' || arg.startsWith('--upload=')) fail('--upload is not a Gmail helper attachment');
    if (arg === '--attach' || arg === '-a') {
      if (index + 1 >= values.length || values[index + 1].startsWith('-')) fail(`${arg} requires a file`);
      slots.push({ argIndex: index + 1, prefix: '', contentType: 'application/octet-stream' });
      index++;
    } else if (arg.startsWith('--attach=')) {
      slots.push({ argIndex: index, prefix: '--attach=', contentType: 'application/octet-stream' });
    } else if (arg.startsWith('-a=')) {
      slots.push({ argIndex: index, prefix: '-a=', contentType: 'application/octet-stream' });
    } else if (arg.startsWith('-a') && arg.length > 2) {
      slots.push({ argIndex: index, prefix: '-a', contentType: 'application/octet-stream' });
    }
  }
  return slots;
}

function rawUploadSlots(values) {
  const slots = [];
  let contentType = values[0] === 'gmail' ? 'message/rfc822' : 'application/octet-stream';
  for (let index = 2; index < values.length; index++) {
    const arg = values[index];
    if (arg === '--upload') {
      if (index + 1 >= values.length || values[index + 1].startsWith('-')) fail('--upload requires a file');
      slots.push({ argIndex: index + 1, prefix: '' });
      index++;
    } else if (arg.startsWith('--upload=')) {
      if (!arg.slice('--upload='.length)) fail('--upload requires a file');
      slots.push({ argIndex: index, prefix: '--upload=' });
    } else if (arg === '--upload-content-type') {
      if (index + 1 >= values.length || values[index + 1].startsWith('-'))
        fail('--upload-content-type requires a MIME value');
      contentType = values[++index];
    } else if (arg.startsWith('--upload-content-type=')) {
      contentType = arg.slice('--upload-content-type='.length);
    }
  }
  if (slots.length > 1) fail('raw --upload must not be repeated');
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(contentType)) fail('upload content type is invalid');
  return slots.map((slot) => ({ ...slot, contentType }));
}

function inputSlots(values) {
  if (values[0] === 'drive' && values[1] === '+upload') return driveUploadSlots(values);
  if (values[0] === 'gmail' && ['+send', '+reply', '+reply-all', '+forward'].includes(values[1])) {
    return gmailAttachmentSlots(values);
  }
  return rawUploadSlots(values);
}

function sourcePathForSlot(values, slot) {
  const value = values[slot.argIndex] ?? '';
  const source = slot.prefix ? value.slice(slot.prefix.length) : value;
  if (!source) fail(`file argument at index ${slot.argIndex} is empty`);
  return source;
}

function stageInputs(proxyArgs, slots) {
  const inputs = [];
  let total = 0;
  for (const [ordinal, slot] of slots.entries()) {
    const source = sourcePathForSlot(proxyArgs, slot);
    let descriptor;
    try {
      descriptor = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch {
      fail(`upload input must be a readable non-symlink file: ${source}`);
    }
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) fail(`upload input must be a regular file: ${source}`);
      const real = fs.realpathSync(`/proc/self/fd/${descriptor}`);
      if (!inputRoots.some((root) => insideRoot(real, root))) {
        fail(`upload input is outside allowed input roots: ${inputRoots.join(':')}`);
      }
      if (stat.size > MAX_FILE_BYTES || total + stat.size > MAX_TOTAL_BYTES)
        fail('upload input exceeds proxy size limits');
      const filename = path.basename(real);
      if (!filename || filename === '.' || filename === '..' || /["\\\x00-\x1f\x7f]/.test(filename)) {
        fail('upload filename is unsafe for multipart transport');
      }
      const stagedPath = path.join(stageDir, `input-${ordinal}`);
      const output = fs.openSync(stagedPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      const hash = crypto.createHash('sha256');
      let size = 0;
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
          const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
          if (count === 0) break;
          if (fs.writeSync(output, buffer, 0, count) !== count) fail('short upload snapshot write');
          hash.update(buffer.subarray(0, count));
          size += count;
          if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) fail('upload input exceeds proxy size limits');
        }
        fs.fsyncSync(output);
      } finally {
        fs.closeSync(output);
      }
      if (size !== stat.size) fail('upload input changed while it was being snapshotted');
      fs.chmodSync(stagedPath, 0o400);
      const placeholder = `/caller/${filename}`;
      proxyArgs[slot.argIndex] = slot.prefix + placeholder;
      inputs.push({
        arg_index: slot.argIndex,
        filename,
        content_type: slot.contentType,
        encoding: 'identity',
        size,
        sha256: hash.digest('hex'),
        stagedPath,
      });
      total += size;
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return inputs;
}

function loadCorrelation() {
  try {
    const before = JSON.parse(fs.readFileSync(process.env.NANOCLAW_HOST_LEASE_FILE, 'utf8'));
    const correlation = JSON.parse(fs.readFileSync(process.env.NANOCLAW_HOST_CORRELATION_FILE, 'utf8'));
    const after = JSON.parse(fs.readFileSync(process.env.NANOCLAW_HOST_LEASE_FILE, 'utf8'));
    const acceptedAt = typeof correlation?.acceptedAt === 'string' ? Date.parse(correlation.acceptedAt) : NaN;
    if (
      before?.schemaVersion !== 1 ||
      JSON.stringify(before) !== JSON.stringify(after) ||
      !canonical(before.leaseId) ||
      correlation?.schemaVersion !== 1 ||
      correlation.leaseId !== before.leaseId ||
      !Number.isFinite(acceptedAt) ||
      !canonical(correlation.inputId) ||
      !canonical(correlation.routeKey)
    )
      throw new Error('host correlation pointer is absent, malformed, or outside the active lease');
    return correlation;
  } catch (error) {
    fail(`refusing GWS request without an exact active host correlation: ${error.message}`);
  }
}

function exactWriteOperation(proxyArgs) {
  if (proxyArgs.some((arg) => ['--help', '-h', '--schema', '--version', '--dry-run'].includes(arg))) return null;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(process.env.GWS_SHIM_WRITE_OPERATIONS_FILE, 'utf8'));
  } catch {
    fail('write-operation manifest is missing or invalid');
  }
  if (manifest?.schema_version !== 1 || manifest?.gws_version !== '0.18.1' || !Array.isArray(manifest.operations)) {
    fail('write-operation manifest has the wrong schema or GWS version');
  }
  return (
    manifest.operations.find((operation) => {
      const words = operation.split(' ');
      return words.every((word, index) => proxyArgs[index] === word);
    }) ?? null
  );
}

const SAFE_RESOURCE_KEYS = new Map(
  [
    'id',
    'fileId',
    'documentId',
    'spreadsheetId',
    'presentationId',
    'calendarId',
    'eventId',
    'messageId',
    'threadId',
    'draftId',
    'taskId',
    'tasklist',
    'tasklistId',
    'parent',
    'parents',
    'name',
    'title',
    'summary',
    'subject',
    'to',
    'cc',
    'bcc',
  ].map((key) => [key.toLowerCase(), key]),
);

function safeResourceValue(value) {
  if (typeof value === 'string') {
    if (!value || value.length > 256 || !/^[\x20-\x7e]+$/.test(value)) return undefined;
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value) && value.length <= 10) {
    const safe = value.map(safeResourceValue);
    if (safe.every((item) => item !== undefined)) return safe;
  }
  return undefined;
}

function collectSafeResourceFields(value, output, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectSafeResourceFields(item, output, depth + 1);
    return;
  }
  for (const [key, candidate] of Object.entries(value)) {
    const canonicalKey = SAFE_RESOURCE_KEYS.get(key.toLowerCase());
    const safe = canonicalKey ? safeResourceValue(candidate) : undefined;
    if (canonicalKey && safe !== undefined && output[canonicalKey] === undefined) output[canonicalKey] = safe;
    collectSafeResourceFields(candidate, output, depth + 1);
  }
}

function manualResourceContext(proxyArgs, inputs) {
  const context = {};
  for (let index = 0; index < proxyArgs.length; index++) {
    const arg = proxyArgs[index];
    let name = '';
    let value;
    if (arg.startsWith('--') && arg.includes('=')) {
      [name, value] = arg.slice(2).split(/=(.*)/s, 2);
    } else if (arg.startsWith('--') && index + 1 < proxyArgs.length && !proxyArgs[index + 1].startsWith('-')) {
      name = arg.slice(2);
      value = proxyArgs[++index];
    }
    if (!name || value === undefined) continue;
    if (name === 'params' || name === 'json') {
      try {
        collectSafeResourceFields(JSON.parse(value), context);
      } catch {
        // The proxy owns final argument validation; omit malformed context here.
      }
      continue;
    }
    const canonicalKey = SAFE_RESOURCE_KEYS.get(name.toLowerCase());
    const safe = canonicalKey ? safeResourceValue(value) : undefined;
    if (canonicalKey && safe !== undefined && context[canonicalKey] === undefined) context[canonicalKey] = safe;
  }
  if (process.env.GWS_PROXY_TARGET_PARENT) context.target_parent = process.env.GWS_PROXY_TARGET_PARENT;
  if (inputs.length > 0) {
    context.uploads = inputs.map((input) => ({
      filename: input.filename,
      size: input.size,
      sha256: input.sha256,
      content_type: input.content_type,
    }));
  }
  return Object.fromEntries(Object.entries(context).sort(([left], [right]) => left.localeCompare(right)));
}

function argumentShape(proxyArgs, operation) {
  const operationWords = operation.split(' ');
  const shape = [...operationWords];
  for (let index = operationWords.length; index < proxyArgs.length; index++) {
    const arg = proxyArgs[index];
    if (arg.startsWith('--') && arg.includes('=')) {
      shape.push(`${arg.slice(0, arg.indexOf('='))}=<value>`);
    } else if (arg.startsWith('-')) {
      shape.push(arg);
      if (index + 1 < proxyArgs.length && !proxyArgs[index + 1].startsWith('-')) {
        shape.push('<value>');
        index++;
      }
    } else {
      shape.push('<positional>');
    }
  }
  return shape;
}

function buildMultipart(request, inputs) {
  if (inputs.length === 0) return { multipartBody: null, multipartContentType: null };
  const boundary = `gws-${crypto.randomBytes(24).toString('hex')}`;
  const multipartBody = path.join(stageDir, 'request.multipart');
  const descriptor = fs.openSync(
    multipartBody,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  const write = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (fs.writeSync(descriptor, bytes) !== bytes.length) fail('short multipart request write');
  };
  try {
    write(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n`);
    write(JSON.stringify({ ...request, inputs: inputs.map(({ stagedPath: _ignored, ...metadata }) => metadata) }));
    write('\r\n');
    for (const input of inputs) {
      write(
        `--${boundary}\r\nContent-Disposition: form-data; name="file-${input.arg_index}"; filename="${input.filename}"\r\nContent-Type: ${input.content_type}\r\n\r\n`,
      );
      const source = fs.openSync(input.stagedPath, 'r');
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
          const count = fs.readSync(source, buffer, 0, buffer.length, null);
          if (count === 0) break;
          write(buffer.subarray(0, count));
        }
      } finally {
        fs.closeSync(source);
      }
      write('\r\n');
    }
    write(`--${boundary}--\r\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return { multipartBody, multipartContentType: `multipart/form-data; boundary=${boundary}` };
}

if (!planPath || !stageDir || args.length === 0) fail('request planner arguments are incomplete');
if (!canonical(process.env.GWS_ACCOUNT)) fail('account selector is invalid');
if (process.env.GWS_PROXY_TARGET_PARENT && !canonical(process.env.GWS_PROXY_TARGET_PARENT))
  fail('target parent is invalid');

const { proxyArgs, outputArg } = parseOutputArgs(args);
const output = planOutput(outputArg);
const slots = inputSlots(proxyArgs);
const inputs = stageInputs(proxyArgs, slots);
const correlation = loadCorrelation();
const writeOperation = exactWriteOperation(proxyArgs);
const request = {
  account: process.env.GWS_ACCOUNT,
  args: proxyArgs,
  input_id: correlation.inputId,
  route_key: correlation.routeKey,
};
if (output) request.output = { mode: 'return_file' };
if (process.env.GWS_PROXY_CONFIRMED === 'true') request.confirmed = true;
if (process.env.GWS_PROXY_TARGET_PARENT) request.target_parent = process.env.GWS_PROXY_TARGET_PARENT;
const multipart = buildMultipart(request, inputs);
const manualReconciliation = writeOperation
  ? {
      schema_version: 1,
      event: 'gws_write_response_lost',
      account: process.env.GWS_ACCOUNT,
      input_id: correlation.inputId,
      route_key: correlation.routeKey,
      operation: writeOperation,
      service: proxyArgs[0],
      argument_shape: argumentShape(proxyArgs, writeOperation),
      args_sha256: crypto.createHash('sha256').update(JSON.stringify(proxyArgs)).digest('hex'),
      resource_context: manualResourceContext(proxyArgs, inputs),
    }
  : null;
fs.writeFileSync(
  planPath,
  JSON.stringify({
    proxyArgs,
    output,
    roots: outputRoots,
    request,
    isWrite: writeOperation !== null,
    manualReconciliation,
    ...multipart,
  }),
);
