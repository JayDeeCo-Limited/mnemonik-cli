import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
/** Registry changes require review and golden cases; changed v1 outputs require v2. */
export const REPOSITORY_PROVIDER_RULES = Object.freeze([
    Object.freeze({ name: 'github', host: 'github.com', sshUser: 'git', removeTerminalDotGit: true }),
]);
const controls = /\p{Cc}/u;
const reject = (reason) => ({ status: 'rejected', reason });
const encodeSegment = (segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
/** Parse the raw path ourselves: WHATWG URL would silently resolve dot segments. */
export function canonicalizeRemote(url, { providerRules = REPOSITORY_PROVIDER_RULES, } = {}) {
    if (controls.test(url))
        return reject('control_character');
    if (url.includes('\\'))
        return reject('backslash');
    if (/^file:/i.test(url))
        return reject('local_remote');
    const input = url.split(/[?#]/, 1)[0] ?? '';
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(input);
    let transport;
    let authority;
    let path;
    if (scheme) {
        const protocol = (scheme[1] ?? '').toLowerCase();
        if (protocol !== 'https' && protocol !== 'ssh')
            return reject('unsupported_transport');
        transport = protocol;
        const parts = /^([^/]*)(?:\/(.*))?$/.exec(input.slice(scheme[0].length));
        if (!parts)
            return reject('invalid_remote');
        authority = parts[1] ?? '';
        path = parts[2] ?? '';
    }
    else {
        const scp = /^((?:[^@/:]+@)?(?:\[[^\]]+\]|[^/:]+)):(.*)$/.exec(input);
        if (!scp)
            return reject('invalid_remote');
        transport = 'ssh';
        authority = scp[1] ?? '';
        path = scp[2] ?? '';
    }
    const at = authority.lastIndexOf('@');
    let user = '';
    if (at >= 0) {
        if (transport === 'https')
            return reject('https_userinfo');
        user = authority.slice(0, at);
        if (user.includes(':'))
            return reject('ssh_password');
        if (!/^[A-Za-z0-9._~!$&'()*+,;=-]+$/.test(user))
            return reject('invalid_ssh_user');
        authority = authority.slice(at + 1);
    }
    if (transport === 'ssh' && !user)
        return reject('ssh_user_required');
    const hostPort = /^(\[[^\]]+\]|[^:[\]]+)(?::([0-9]+))?$/.exec(authority);
    if (!hostPort)
        return reject(authority.includes(':') ? 'invalid_port' : 'invalid_host');
    let host = hostPort[1] ?? '';
    let port = hostPort[2] ?? '';
    if (port && (Number(port) < 1 || Number(port) > 65535))
        return reject('invalid_port');
    if (port)
        port = String(Number(port));
    if (port === (transport === 'https' ? '443' : '22'))
        port = '';
    if (/[\s%/@?#]/u.test(host))
        return reject('invalid_host');
    try {
        // Node's WHATWG host parser supplies UTS 46 ToASCII and IPv6 zero compression.
        host = host.startsWith('[')
            ? new URL(`https://${host}/`).hostname
            : domainToASCII(host).toLowerCase();
        if (!host)
            return reject('invalid_host');
    }
    catch {
        return reject('invalid_host');
    }
    const rule = providerRules.find((rule) => rule.host === host && !port && (transport === 'https' || user === rule.sshUser));
    // Generic scp paths are home-relative; ssh:// paths are absolute. Only a
    // reviewed provider rule can establish that both name the same repository.
    if (!scheme && !rule)
        return reject('scp_unreviewed_remote');
    if (!scheme && path.startsWith('/'))
        path = path.slice(1);
    if (path.endsWith('/'))
        path = path.slice(0, -1);
    const segments = [];
    for (const raw of path.split('/')) {
        if (/%(?:2f|5c)/i.test(raw))
            return reject('escaped_separator');
        let segment;
        try {
            segment = decodeURIComponent(raw).normalize('NFC');
        }
        catch {
            return reject('invalid_encoding');
        }
        if (controls.test(segment))
            return reject('control_character');
        if (segment.includes('\\'))
            return reject('backslash');
        if (!segment)
            return reject('empty_segment');
        if (segment === '.' || segment === '..')
            return reject('dot_segment');
        try {
            segments.push(encodeSegment(segment));
        }
        catch {
            return reject('invalid_encoding');
        }
    }
    const parsed = { transport, host, user, port, path: segments.join('/') };
    if (rule?.removeTerminalDotGit) {
        parsed.path = parsed.path.replace(/\.git$/, '');
        const last = parsed.path.split('/').at(-1);
        if (!last)
            return reject('empty_segment');
        if (last === '.' || last === '..')
            return reject('dot_segment');
    }
    const prefix = rule
        ? `${rule.name}:${host}`
        : `${transport}:${transport === 'ssh' ? `${user}@` : ''}${host}${port ? `:${port}` : ''}`;
    const canonical = `repo-v1:${prefix}/${parsed.path}`;
    return {
        canonical,
        hash: createHash('sha256').update(canonical, 'utf8').digest('hex'),
        algorithmVersion: 1,
    };
}
/** Choice results carry names, never credential-bearing URLs. No URL is guessed. */
export function selectRemote(remotes) {
    if (!remotes.length)
        return { status: 'none', reason: 'no_remote' };
    const origins = remotes.filter((remote) => remote.name === 'origin');
    const selected = origins.length === 1 ? origins[0] : remotes.length === 1 ? remotes[0] : undefined;
    if (!selected)
        return {
            status: 'choice_required',
            reason: 'multiple_remotes',
            remotes: remotes.map((r) => r.name),
        };
    if (!selected.fetchUrls.length)
        return { status: 'none', reason: 'no_fetch_url' };
    const results = [...selected.fetchUrls, ...(selected.pushUrls ?? [])].map((url) => canonicalizeRemote(url));
    const first = results[0];
    if (!first)
        return { status: 'none', reason: 'no_fetch_url' };
    if (results.length === 1 && 'reason' in first)
        return { status: 'rejected', remote: selected.name, reason: first.reason };
    if ('reason' in first ||
        results.some((result) => 'reason' in result || result.canonical !== first.canonical)) {
        return { status: 'choice_required', reason: 'different_urls', remotes: [selected.name] };
    }
    return { status: 'fingerprint', remote: selected.name, fingerprint: first };
}
//# sourceMappingURL=repositoryFingerprint.js.map