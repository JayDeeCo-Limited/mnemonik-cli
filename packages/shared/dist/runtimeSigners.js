import { lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep, win32 } from 'node:path';
import { createHash, createPublicKey, randomUUID, timingSafeEqual, verify as verifySignature, } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
export const execute = (file, args, input) => {
    const result = promisify(execFile)(file, args);
    if (input === undefined)
        return result;
    return new Promise((resolve, reject) => {
        void result.then(resolve, reject);
        result.child.stdin?.on('error', reject);
        result.child.stdin?.end(input);
    });
};
const quote = (text) => `'${text.replaceAll("'", "''")}'`;
function decodeBase64(text, length) {
    const bytes = Buffer.from(text, 'base64');
    if (bytes.length !== length || bytes.toString('base64') !== text)
        throw new Error('unsigned');
    return bytes;
}
/** Pinned release identity; a downloaded manifest can never replace its own trust anchor. */
export const RELEASE_MINISIGN_PUBLIC_KEY = 'RWSBYwgbjz0qKB4/ToA3dywBiAlQeBjoQpib4OHdjP2nDbpQnOVqpPm0';
export function verifyMinisign(message, signatureText, identity = RELEASE_MINISIGN_PUBLIC_KEY) {
    const publicPacket = decodeBase64(identity, 42);
    const lines = signatureText.trimEnd().split(/\r?\n/);
    const [untrustedComment, encodedSignature, trustedLine, encodedGlobalSignature] = lines;
    if (publicPacket.subarray(0, 2).toString() !== 'Ed' ||
        lines.length !== 4 ||
        !untrustedComment?.startsWith('untrusted comment:') ||
        !encodedSignature ||
        !trustedLine?.startsWith('trusted comment: ') ||
        !encodedGlobalSignature)
        throw new Error('unsigned');
    const signaturePacket = decodeBase64(encodedSignature, 74);
    const globalSignature = decodeBase64(encodedGlobalSignature, 64);
    const algorithm = signaturePacket.subarray(0, 2).toString();
    if ((algorithm !== 'ED' && algorithm !== 'Ed') ||
        !timingSafeEqual(publicPacket.subarray(2, 10), signaturePacket.subarray(2, 10)))
        throw new Error('unsigned');
    const publicKey = createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicPacket.subarray(10)]),
        format: 'der',
        type: 'spki',
    });
    const fileSignature = signaturePacket.subarray(10);
    const signedMessage = algorithm === 'ED' ? createHash('blake2b512').update(message).digest() : message;
    const trustedComment = trustedLine.slice('trusted comment: '.length);
    if (!verifySignature(null, signedMessage, publicKey, fileSignature) ||
        !verifySignature(null, Buffer.concat([fileSignature, Buffer.from(trustedComment)]), publicKey, globalSignature))
        throw new Error('unsigned');
}
async function verifyMinisignFile(path, signaturePath, identity) {
    const [message, signatureText] = await Promise.all([
        readFile(path),
        readFile(signaturePath, 'utf8'),
    ]);
    verifyMinisign(message, signatureText, identity);
}
/** Release tooling supplies the real identity and artifacts. These checks do not sign anything. */
export async function verifySigner(path, signer, run = execute) {
    if (signer.platform === 'darwin' && /^[A-Z0-9]{10}$/.test(signer.identity)) {
        // codesign is the whole darwin check. spctl --assess --type execute only
        // assesses app bundles and rejects every bare Mach-O executable, Apple's
        // own shipped ones included, so running it would refuse every signed
        // scanner. -R reads its argument as a requirement file path unless it
        // starts with "=", which makes the rest of that argument the requirement
        // text itself.
        await run('/usr/bin/codesign', [
            '--verify',
            '--strict',
            '-R',
            `=anchor apple generic and certificate leaf[subject.OU] = "${signer.identity}"`,
            path,
        ]);
    }
    else if (signer.platform === 'win32' && /^[A-Fa-f0-9]{40}$/.test(signer.identity)) {
        await run('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$ErrorActionPreference = 'Stop'; $s = Get-AuthenticodeSignature -LiteralPath ${quote(path)}; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Thumbprint -ne ${quote(signer.identity)}) { exit 1 }`,
        ]);
    }
    else if (signer.platform === 'linux') {
        try {
            await verifyMinisignFile(path, signer.signature, signer.identity);
        }
        catch {
            throw new Error('unsigned');
        }
    }
    else
        throw new Error('unsigned');
}
/** Windows stat mode/uid are not ACL evidence. */
export async function verifyWindowsPermission(path, run = hookExecute, state) {
    const verdicts = await auditWindowsPermissions(path, [path], run, false, state);
    if (verdicts.get(path) === 'acl_unavailable')
        throw new Error('acl_unavailable');
    if (verdicts.get(path) !== 'ok')
        throw new Error('acl_permissions');
}
const identityArgs = ['/user', '/fo', 'csv', '/nh'];
function windowsCommand(file) {
    const root = process.env.SystemRoot;
    if (!root || !win32.isAbsolute(root))
        throw new Error('acl_system_root_unavailable');
    return win32.join(root, 'System32', file);
}
let currentIdentity;
const receipts = new Map();
const ttl = 10 * 60_000;
const fresh = (time) => time !== undefined && Date.now() >= time && Date.now() - time < ttl;
function readIdentity(stdout) {
    const match = /^"([^"\r\n]+)","(S-1-(?:\d+-)+\d+)"$/.exec(stdout.trim());
    if (!match?.[1] || !match[2] || stdout.includes('\uFFFD'))
        throw new Error('acl_identity_unavailable');
    return { name: match[1], sid: match[2] };
}
export function windowsCurrentAccountSync() {
    return (currentIdentity ??= readIdentity(hookExecuteSync(windowsCommand('whoami.exe'), identityArgs)));
}
let identityPending;
async function windowsIdentity(run) {
    if (currentIdentity)
        return currentIdentity;
    identityPending ??= run(windowsCommand('whoami.exe'), identityArgs)
        .then((result) => (currentIdentity = readIdentity(stdout(result))))
        .finally(() => {
        identityPending = undefined;
    });
    return identityPending;
}
/** Frequent config polling checks fresh ACEs; stat changes trigger a full owner audit. */
export async function verifyWindowsAcl(path, run = hookExecute, state) {
    const user = await windowsIdentity(run);
    if (!privateEntries((await drive(saveAcl(path, false, [path], state), run)).get(path), user, false))
        throw new Error('acl_permissions');
}
const aclArgs = (path, sid) => [
    path,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(OI)(CI)F`,
];
// Keep injected runners at the logical-command boundary; native execution owns encoding.
function hookInvocation(file, args) {
    if (win32.basename(file) === 'whoami.exe') {
        if ([file, ...args].some((arg) => /[%!"\r\n]/.test(arg)))
            throw new Error('acl_path_unavailable');
        const command = args
            .map((arg) => (/^(?:[a-z0-9]+|\/[a-z]+)$/i.test(arg) ? arg : `"${arg}"`))
            .join(' ');
        return [
            windowsCommand('cmd.exe'),
            ['/d', '/v:off', '/s', '/c', `"chcp 65001>nul & "${file}" ${command}"`],
        ];
    }
    if (win32.basename(file) === 'cmd.exe')
        return [file, ['/u', ...args]];
    return [file, args];
}
const hookOptions = (file, args) => ({
    encoding: args.includes('/u') ? 'utf16le' : 'utf8',
    timeout: win32.basename(file) === 'powershell.exe' ? 30_000 : 5_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    windowsVerbatimArguments: win32.basename(file) === 'cmd.exe',
});
function hookExecuteSync(file, args, input) {
    [file, args] = hookInvocation(file, args);
    return execFileSync(file, args, { ...hookOptions(file, args), input });
}
const hookExecute = (file, args, input) => {
    const treeListing = (win32.basename(file) === 'icacls.exe' && args.includes('/t')) ||
        (win32.basename(file) === 'cmd.exe' && args.some((arg) => arg.startsWith('dir /q /a /s ')));
    [file, args] = hookInvocation(file, args);
    const options = hookOptions(file, args);
    if (treeListing)
        options.timeout = 30_000;
    return new Promise((resolve, reject) => {
        const child = execFile(file, args, options, (error, stdout) => error ? reject(error) : resolve({ stdout }));
        if (input !== undefined) {
            child.stdin?.on('error', reject);
            child.stdin?.end(input);
        }
    });
};
const stdout = (value) => value.stdout;
/** icacls /save writes alternating relative paths and SDDL in UTF-16LE. */
export function aclRecords(output, root, paths, onLookup) {
    const records = new Map();
    const wanted = new Set(paths);
    const lines = output
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split(/\r?\n/);
    if (lines.length % 2)
        throw new Error('acl_unavailable');
    for (let index = 0; index < lines.length; index += 2) {
        onLookup?.();
        const relativePath = lines[index];
        const descriptor = lines[index + 1];
        if (relativePath === undefined || descriptor === undefined)
            throw new Error('acl_unavailable');
        const path = resolve(dirname(root), relativePath.replaceAll('\\', sep));
        if (!wanted.has(path))
            continue;
        if (records.has(path))
            throw new Error('acl_unavailable');
        const dacl = /^D:(?:P|AI|AR)*((?:\([^()]*\))*)$/.exec(descriptor);
        records.set(path, dacl?.[1]?.match(/\([^()]*\)/g) ?? []);
    }
    return records;
}
function privateEntries(entries, user, directory) {
    if (!entries?.length)
        throw new Error('acl_unavailable');
    return entries.every((line) => {
        const ace = /^\(([AD]);((?:OI|CI|NP|IO|ID|SA|FA)*);[A-Za-z0-9]+;;;((?:S-1-(?:\d+-)+\d+)|[A-Z]{2})\)$/.exec(line);
        if (!ace)
            throw new Error('acl_unavailable');
        return (!directory || !ace[2]?.includes('ID')) && (ace[1] === 'D' || ace[3] === user.sid);
    });
}
const auditDirectories = new Set();
function* prepareAclDirectory(state) {
    const directory = join(state, 'audit-tmp');
    if (auditDirectories.has(directory)) {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error('acl_permissions');
        return directory;
    }
    let created = false;
    try {
        mkdirSync(directory, { mode: 0o700 });
        created = true;
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('acl_permissions');
    if (!auditDirectories.has(directory)) {
        currentIdentity ??= readIdentity(yield [windowsCommand('whoami.exe'), identityArgs]);
        yield [windowsCommand('icacls.exe'), aclArgs(directory, currentIdentity.sid)];
        if (!created) {
            const temp = join(directory, `.acl-${randomUUID()}.tmp`);
            writeFileSync(temp, '', { flag: 'wx', mode: 0o600 });
            try {
                yield [windowsCommand('icacls.exe'), [directory, '/save', temp, '/l']];
                if (!privateEntries(aclRecords(readFileSync(temp, 'utf16le'), directory, [directory]).get(directory), currentIdentity, true))
                    throw new Error('acl_permissions');
            }
            finally {
                unlinkSync(temp);
            }
        }
        auditDirectories.add(directory);
    }
    return directory;
}
const directoryPending = new Map();
export async function prepareWindowsAclDirectory(state, run = hookExecute) {
    let pending = directoryPending.get(state);
    if (!pending) {
        pending = drive(prepareAclDirectory(state), run)
            .then(() => { })
            .finally(() => directoryPending.delete(state));
        directoryPending.set(state, pending);
    }
    await pending;
}
/** Inherits the already-private parent ACL; never parses the OEM console output. */
function* saveAcl(path, recursive, paths = [path], state = lstatSync(path).isDirectory() ? path : dirname(path)) {
    const directory = yield* prepareAclDirectory(state);
    const temp = join(directory, `.acl-${randomUUID()}.tmp`);
    writeFileSync(temp, '', { flag: 'wx', mode: 0o600 });
    try {
        yield [windowsCommand('icacls.exe'), [path, '/save', temp, ...(recursive ? ['/t'] : []), '/l']];
        // The export may contain its own temporary file. Only requested paths are parsed.
        return aclRecords(readFileSync(temp, 'utf16le'), path, paths.filter((item) => item !== directory && !item.startsWith(directory + sep)));
    }
    finally {
        unlinkSync(temp);
    }
}
async function drive(commands, run) {
    try {
        let step = commands.next();
        while (!step.done)
            step = commands.next(stdout(await run(...step.value)));
        return step.value;
    }
    finally {
        commands.return(undefined);
    }
}
// Native dir /q: metadata width varies with the clock format; owner is 23 characters.
// A full owner column is silently truncated: no ellipsis or separating space.
const ownerWidth = 23;
function dirEntry(line) {
    // Size grouping is culture-dependent (fr-FR uses U+202F).
    const metadata = /^\S+\s+\S+(?:\s+\S+)?\s+(?:<DIR>|\d[\d,.\s]*)\s+/.exec(line)?.[0];
    if (!metadata)
        return undefined;
    const ownerColumn = metadata.length;
    const owner = line
        .slice(ownerColumn, ownerColumn + ownerWidth)
        .trim()
        .toLowerCase();
    const name = line.slice(ownerColumn + ownerWidth);
    return owner && name ? { owner, name } : undefined;
}
const unknownOwner = (owner, user) => user.name.length >= ownerWidth || owner.length >= ownerWidth || owner.includes('...');
function ownerLookup(paths) {
    if (paths.some((path) => /[\t\r\n]/.test(path)))
        throw new Error('acl_path_unavailable');
    const script = `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
while ($null -ne ($path = [Console]::ReadLine())) {
  $owner = (Get-Acl -LiteralPath $path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  [Console]::WriteLine($path + "\`t" + $owner)
}`;
    return [
        windowsCommand('WindowsPowerShell\\v1.0\\powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', script],
        paths.join('\n') + '\n',
    ];
}
function ownerSids(output) {
    const owners = new Map();
    for (const line of output.split(/\r?\n/)) {
        const [path, sid] = line.split('\t');
        if (path && sid && /^S-1-(?:\d+-)+\d+$/.test(sid))
            owners.set(path, sid.toLowerCase());
    }
    return owners;
}
/** One command sequence for both async hooks and synchronous cache writers.
 * The session receipt deliberately trusts previously audited paths for ten minutes. */
function* hookPermission(path, created, session, directory = true) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
        throw new Error('cache unavailable');
    const marker = join(session, '.windows-acl.json');
    let receipt = receipts.get(session);
    if (!receipt) {
        try {
            if (lstatSync(session).isSymbolicLink() ||
                !lstatSync(marker).isFile() ||
                lstatSync(marker).isSymbolicLink())
                throw new Error('cache unavailable');
            receipt = JSON.parse(readFileSync(marker, 'utf8'));
            if (!receipt ||
                !receipt.paths ||
                !receipt.identity ||
                !/^S-1-(?:\d+-)+\d+$/.test(receipt.identity.sid) ||
                typeof receipt.identity.name !== 'string')
                receipt = undefined;
        }
        catch {
            /* No usable session receipt. */
        }
    }
    if (receipt && currentIdentity && receipt.identity.sid !== currentIdentity.sid)
        receipt = undefined;
    if (!created && receipt && Object.hasOwn(receipt.paths, path) && fresh(receipt.paths[path])) {
        currentIdentity ??= receipt.identity;
        receipts.set(session, receipt);
        return;
    }
    currentIdentity ??= readIdentity(yield [windowsCommand('whoami.exe'), identityArgs]);
    const user = currentIdentity;
    if (receipt && receipt.identity.sid !== user.sid)
        receipt = undefined;
    // cmd is needed only for its built-in dir. Reject expansion/quote characters;
    // the quoted parent remains one literal argument, including spaces and &.
    const parent = dirname(path);
    if (/[%!"\r\n]/.test(parent))
        throw new Error('acl_path_unavailable');
    const listing = yield [
        windowsCommand('cmd.exe'),
        ['/d', '/v:off', '/s', '/c', `dir /q ${directory ? '/a:d' : '/a'} "${parent}"`],
    ];
    const owners = listing.split(/\r?\n/).flatMap((line) => {
        const entry = dirEntry(line);
        return entry?.name.toLowerCase() === basename(path).toLowerCase() ? [entry.owner] : [];
    });
    let owner = owners[0];
    if (owners.length === 1 && owner && unknownOwner(owner, user))
        owner = ownerSids(yield ownerLookup([path])).get(path);
    if (owners.length !== 1 ||
        ![user.name.toLowerCase(), user.sid.toLowerCase()].includes(owner ?? ''))
        throw new Error('acl_owner');
    const icacls = windowsCommand('icacls.exe');
    if (created)
        yield [icacls, aclArgs(path, user.sid)];
    let valid = privateEntries((yield* saveAcl(path, false)).get(path), user, directory);
    if (!valid && !created && directory) {
        yield [icacls, aclArgs(path, user.sid)];
        valid = privateEntries((yield* saveAcl(path, false)).get(path), user, directory);
    }
    if (!valid)
        throw new Error('acl_permissions');
    receipt ??= { identity: user, paths: {} };
    receipt.paths[path] = Date.now();
    receipts.set(session, receipt);
    // Root is audited before the session exists; its receipt is flushed by the
    // subsequent session-directory audit. Atomic rename avoids partial JSON.
    try {
        const temp = `${marker}.${randomUUID()}`;
        writeFileSync(temp, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
        renameSync(temp, marker);
    }
    catch {
        /* A missing receipt costs another audit next process. */
    }
}
export async function windowsCurrentUserDirectoryAcl(path, run = hookExecute) {
    currentIdentity ??= readIdentity(stdout(await run(windowsCommand('whoami.exe'), identityArgs)));
    await run(windowsCommand('icacls.exe'), aclArgs(path, currentIdentity.sid));
}
export async function protectWindowsDirectory(path, created, run = hookExecute, session = path) {
    await drive(hookPermission(path, created, session), run);
}
function protectSync(path, created, session, directory = true) {
    const audit = hookPermission(path, created, session, directory);
    try {
        let step = audit.next();
        while (!step.done)
            step = audit.next(hookExecuteSync(...step.value));
    }
    finally {
        audit.return();
    }
}
/** File ACEs may inherit from their already-private parent. */
export function verifyWindowsPermissionSync(path) {
    protectSync(path, false, dirname(path), false);
}
export function ensureWindowsPrivateDirectorySync(path, session = path) {
    if (process.platform !== 'win32')
        return;
    const created = mkdirSync(path, { recursive: true, mode: 0o700 });
    protectSync(path, created !== undefined, session);
}
/** Recursive native listings are attributed by absolute path; missing entries fall back. */
export async function auditWindowsPermissions(state, paths, run = hookExecute, recursive = true, tempState = lstatSync(state).isDirectory() ? state : dirname(state)) {
    const user = await windowsIdentity(run);
    const root = resolve(state);
    for (const path of paths)
        if (resolve(path) !== root && !resolve(path).startsWith(root + sep))
            throw new Error('acl_path_unavailable');
    if (/[%!"\r\n]/.test(root))
        throw new Error('acl_path_unavailable');
    const owners = new Map();
    // The shallow parent listing supplies the root's owner, including drive-root state paths.
    for (const [directory, descend] of [
        [dirname(root), false],
        ...(recursive ? [[root, true]] : []),
    ]) {
        if (/[%!"\r\n]/.test(directory))
            throw new Error('acl_path_unavailable');
        const output = stdout(await run(windowsCommand('cmd.exe'), [
            '/d',
            '/v:off',
            '/s',
            '/c',
            `dir /q /a ${descend ? '/s ' : ''}"${directory}"`,
        ]));
        let current = directory;
        for (const line of output.split(/\r?\n/)) {
            const entry = dirEntry(line);
            if (entry) {
                if (entry.name !== '..')
                    owners.set(join(current, entry.name), unknownOwner(entry.owner, user) ? '...' : entry.owner);
            }
            else {
                // Directory headers are localized; their absolute path is not.
                const header = /(?:^|\s)((?:[A-Za-z]:\\|\\\\|\/).*)$/.exec(line.trim());
                if (header?.[1])
                    current = header[1];
            }
        }
    }
    const verdicts = new Map();
    const ownerPaths = [...owners.keys()].filter((path) => path === root || path.startsWith(root + sep));
    const truncated = new Set(ownerPaths.filter((path) => owners.get(path)?.includes('...')));
    if (truncated.size) {
        const result = await run(...ownerLookup([...truncated])).catch(() => ({ stdout: '' }));
        for (const [path, sid] of ownerSids(stdout(result)))
            if (truncated.has(path))
                owners.set(path, sid);
    }
    for (const [path, entries] of await drive(saveAcl(root, recursive, ownerPaths, tempState), run)) {
        const owner = owners.get(path) ?? '...';
        const owned = owner === user.name.toLowerCase() || owner === user.sid.toLowerCase();
        try {
            if (!entries.length || owner.includes('...'))
                throw new Error('acl_unavailable');
            verdicts.set(path, !owned ? 'owner' : privateEntries(entries, user, false) ? 'ok' : 'ace');
        }
        catch {
            verdicts.set(path, 'acl_unavailable');
        }
    }
    return verdicts;
}
//# sourceMappingURL=runtimeSigners.js.map