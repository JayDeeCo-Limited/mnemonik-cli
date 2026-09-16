import { createHash } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createCredentialAdapter, } from '@mnemonik/credentials';
import { atomicWrite, stateDirectory } from '@mnemonik/local-setup';
import { RuntimeStore } from './runtime/store.js';
export class DiagnosticsError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'DiagnosticsError';
    }
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validId = (id) => /^diag-[A-Za-z0-9._-]{1,120}$/u.test(id);
async function scannerConfig(stateDir) {
    const state = JSON.parse(await readFile(join(stateDir, 'scanner', 'state.json'), 'utf8'));
    if (typeof state.config?.serverUrl !== 'string' ||
        typeof state.config.credentialFamilyId !== 'string')
        throw new DiagnosticsError('scanner_credential_missing');
    return {
        serverUrl: state.config.serverUrl.replace(/\/$/u, ''),
        credentialFamilyId: state.config.credentialFamilyId,
    };
}
function rotationTransport(serverUrl, fetcher) {
    const request = async (path, refreshToken) => {
        const response = await fetcher(`${serverUrl}${path}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${refreshToken}` },
        });
        return {
            status: response.status,
            body: (await response.json().catch(() => ({}))),
            ...(response.headers.has('retry-after')
                ? { retryAfterMs: Number(response.headers.get('retry-after')) * 1000 }
                : {}),
        };
    };
    return {
        rotateFamily: (id, token) => request(`/api/v1/component-credentials/${encodeURIComponent(id)}/rotate`, token),
        revokeFamily: (id, token) => request(`/api/v1/component-credentials/${encodeURIComponent(id)}/revoke`, token),
    };
}
export async function previewDiagnostics(out, dependencies = {}) {
    const stateDir = dependencies.stateDir ?? stateDirectory();
    const binary = dependencies.scannerBinary
        ? await dependencies.scannerBinary()
        : (await new RuntimeStore(stateDir).verifyRuntime('scanner')).entry;
    const args = ['diagnostics', 'bundle', ...(out ? ['--out', out] : []), '--json'];
    const stdout = await new Promise((resolve, reject) => {
        (dependencies.execFile ?? nodeExecFile)(binary, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, output) => {
            if (error)
                reject(error);
            else
                resolve(String(output));
        });
    });
    let result;
    try {
        result = JSON.parse(stdout);
    }
    catch {
        throw new DiagnosticsError('diagnostics_preview_invalid');
    }
    if (!validId(result.manifest?.bundleId) ||
        !/^[a-f0-9]{64}$/u.test(result.sha256) ||
        typeof result.path !== 'string')
        throw new DiagnosticsError('diagnostics_preview_invalid');
    const receipt = { schemaVersion: 1, ...result };
    const receiptPath = join(stateDir, 'diagnostics', `${result.manifest.bundleId}.json`);
    await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
    await atomicWrite(receiptPath, Buffer.from(`${JSON.stringify(receipt)}\n`));
    return result;
}
/** Network boundary. Its sole call site is sendDiagnostics below. */
export async function uploadDiagnosticsBundle(serverUrl, token, bundleId, sha256, bytes, fetcher) {
    const response = await fetcher(`${serverUrl}/api/v1/diagnostics/bundles`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/gzip',
            'x-mnemonik-bundle-id': bundleId,
            'x-mnemonik-bundle-sha256': sha256,
        },
        body: bytes,
    });
    return {
        status: response.status,
        body: (await response.json().catch(() => ({}))),
    };
}
export async function sendDiagnostics(bundleId, dependencies = {}) {
    if (!validId(bundleId))
        throw new DiagnosticsError('bundle_id_invalid');
    const stateDir = dependencies.stateDir ?? stateDirectory();
    const receiptPath = join(stateDir, 'diagnostics', `${bundleId}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (receipt.schemaVersion !== 1 ||
        receipt.manifest?.bundleId !== bundleId ||
        !/^[a-f0-9]{64}$/u.test(receipt.sha256) ||
        typeof receipt.path !== 'string' ||
        !(await lstat(receipt.path)).isFile())
        throw new DiagnosticsError('diagnostics_preview_invalid');
    const bytes = await readFile(receipt.path);
    if (digest(bytes) !== receipt.sha256)
        throw new DiagnosticsError('bundle_hash_mismatch');
    const config = await scannerConfig(stateDir);
    const fetcher = dependencies.fetch ?? fetch;
    const credentials = dependencies.credentials ?? createCredentialAdapter({ stateDir });
    const response = await credentials.withCredential(config.credentialFamilyId, dependencies.rotation ?? rotationTransport(config.serverUrl, fetcher), (token) => uploadDiagnosticsBundle(config.serverUrl, token, bundleId, receipt.sha256, bytes, fetcher));
    if (!('body' in response))
        throw new DiagnosticsError(`credential_${response.reason}`);
    if (response.status < 200 || response.status >= 300)
        throw new DiagnosticsError(typeof response.body.error === 'string'
            ? response.body.error
            : `diagnostics_upload_${response.status}`);
    return { ...response.body, bundleId, sha256: receipt.sha256, bytes: bytes.length };
}
//# sourceMappingURL=diagnostics.js.map