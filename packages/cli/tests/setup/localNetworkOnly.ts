import { Socket } from 'node:net';

// Unit tests may use local HTTP fixtures. Missing transport injection must fail
// before DNS or a connection, even for clients which do not use global fetch.
const local = (host: unknown) =>
  host === undefined ||
  host === 'localhost' ||
  host === '127.0.0.1' ||
  host === '::1' ||
  host === '[::1]';
const refused = () => new Error('CLI tests cannot access external networks');
const originalConnect = Socket.prototype.connect;
Socket.prototype.connect = function (this: Socket, ...raw: unknown[]) {
  const args = Array.isArray(raw[0]) ? raw[0] : raw;
  const first = args[0];
  const options = typeof first === 'object' && first !== null ? first : undefined;
  const host = options
    ? (options as { host?: string }).host
    : typeof args[1] === 'string'
      ? args[1]
      : undefined;
  if (!local(host)) throw refused();
  return Reflect.apply(originalConnect, this, raw);
} as typeof originalConnect;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof globalThis.Request ? input.url : input.toString());
  if (!local(url.hostname)) throw refused();
  return originalFetch(input, init);
};

/**
 * The guard catches a missing transport injection. A test whose subject is the
 * real npm registry says so here instead of being refused.
 */
export function allowExternalNetwork(): void {
  Socket.prototype.connect = originalConnect;
  globalThis.fetch = originalFetch;
}
