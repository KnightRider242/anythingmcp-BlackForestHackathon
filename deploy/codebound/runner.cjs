// SPDX-License-Identifier: AGPL-3.0-only
// This entire process is untrusted. The host independently validates all frames.
const readline = require('node:readline');
const write = process.stdout.write.bind(process.stdout);
const exit = process.exit.bind(process);
const send = (message) => write(JSON.stringify(message) + '\n');
// Refuse to evaluate source if the host silently disabled these kernel guards.
const status = require('node:fs').readFileSync('/proc/self/status', 'utf8');
if (process.getuid() !== 65534 || !/^CapEff:\s+0+$/m.test(status) ||
    !/^NoNewPrivs:\s+1$/m.test(status) || !/^Seccomp:\s+2$/m.test(status)) exit(125);
let started = false;
let requested = false;
let pending;
let limits;

// Do not silently coerce undefined, functions, NaN, getters or cycles into JSON.
function assertJson(value, seen = new Set(), depth = 0) {
  if (depth > 32) throw new Error();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value)) throw new Error();
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new Error();
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new Error();
    assertJson(descriptor.value, seen, depth + 1);
  }
  if (array && Object.keys(value).length !== value.length) throw new Error();
  seen.delete(value);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
send({ type: 'ready' });
lines.on('line', async (line) => {
  try {
    const message = JSON.parse(line);
    if (started) {
      if (!pending || message.type !== 'connector.reply' || message.requestId !== 'read-1') throw new Error();
      const { resolve, reject } = pending;
      pending = undefined;
      if (message.ok) resolve(message.value);
      else reject(new Error('Connector operation failed'));
      return;
    }
    started = true;
    limits = message.limits;
    const api = Object.freeze({ read: async (arguments_) => {
      if (requested) {
        send({ type: 'error', code: 'RESOURCE_LIMIT', limit: 'connectorCalls' });
        exit(1);
      }
      requested = true;
      assertJson(arguments_);
      const reply = new Promise((resolve, reject) => { pending = { resolve, reject }; });
      send({ type: 'connector.call', requestId: 'read-1', binding: 'connector.read', arguments: arguments_ });
      return reply;
    } });
    // Code evaluation occurs ONLY in this disposable container, never in NestJS.
    const run = new Function('input', 'api', '"use strict";\n' + message.source + '\nreturn main(input, api);');
    const output = await run(message.input, api);
    try { assertJson(output); } catch { send({ type: 'error', code: 'INVALID_OUTPUT' }); exit(1); }
    if (Buffer.byteLength(JSON.stringify(output)) > limits.maxOutputBytes) {
      send({ type: 'error', code: 'RESOURCE_LIMIT', limit: 'outputBytes' });
      exit(1);
    }
    send({ type: 'result', output });
    exit(0);
  } catch {
    send({ type: 'error', code: 'SCRIPT_ERROR' });
    exit(1);
  }
});
