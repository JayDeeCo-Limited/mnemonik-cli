import { ensureWindowsPrivateDirectorySync } from './runtimeSigners.js';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, } from 'node:fs';
import { join } from 'node:path';
import { stderr } from 'node:process';
const DELIVERY_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOOK_VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const MAX_PENDING_REFS = 8;
const DELIVERY_REF_RETENTION_MS = 240_000;
export function normalizeJitHookVersion(hookVersion) {
    if (hookVersion === undefined || hookVersion === null)
        return 'unknown';
    return typeof hookVersion === 'string' &&
        hookVersion.length <= 64 &&
        HOOK_VERSION_RE.test(hookVersion)
        ? hookVersion
        : 'unrecognized';
}
function hash(value) {
    return createHash('sha256').update(value).digest('hex');
}
function emitReceiptEvent(context, event, deliveryRef, reason) {
    if (!context)
        return;
    const record = {
        mnemonik_marker: 'jit_receipt_client',
        event,
        deliveryRefHash: hash(deliveryRef),
        sessionFingerprint: hash(context.sessionId).slice(0, 16),
        hookVersion: normalizeJitHookVersion(context.hookVersion),
        ...(reason ? { reason } : {}),
    };
    try {
        if (context.emit)
            context.emit(record);
        else
            stderr.write(`${JSON.stringify(record)}\n`);
    }
    catch {
        // Receipt instrumentation must never interfere with the host turn.
    }
}
function ensurePrivateDirectory(path) {
    if (!path)
        return false;
    try {
        if (existsSync(path) && lstatSync(path).isSymbolicLink())
            return false;
        ensureWindowsPrivateDirectorySync(path);
        mkdirSync(path, { recursive: true, mode: 0o700 });
        chmodSync(path, 0o700);
        return lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink();
    }
    catch {
        return false;
    }
}
/** Persist only after the final host-visible payload contains this JIT result. */
export function persistJitDeliveryRef(directory, deliveryRef, context) {
    if (!DELIVERY_REF_RE.test(deliveryRef) || !ensurePrivateDirectory(directory))
        return false;
    let fd = null;
    try {
        fd = openSync(join(directory, deliveryRef), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
        emitReceiptEvent(context, 'marker_persisted', deliveryRef);
        return true;
    }
    catch {
        // An existing marker is already the desired idempotent state.
        try {
            const stat = lstatSync(join(directory, deliveryRef));
            const persisted = stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
            if (persisted)
                emitReceiptEvent(context, 'marker_persisted', deliveryRef);
            return persisted;
        }
        catch {
            return false;
        }
    }
    finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            }
            catch {
                // Receipt persistence is fail-open for the host turn.
            }
        }
    }
}
export function readPendingJitDeliveryRefs(directory, context) {
    if (!directory)
        return [];
    try {
        if (!existsSync(directory))
            return [];
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            return [];
        const now = Date.now();
        const live = [];
        for (const deliveryRef of readdirSync(directory)) {
            if (!DELIVERY_REF_RE.test(deliveryRef))
                continue;
            const markerPath = join(directory, deliveryRef);
            try {
                const marker = lstatSync(markerPath);
                if (!marker.isFile() || marker.isSymbolicLink())
                    continue;
                if (now - marker.mtimeMs >= DELIVERY_REF_RETENTION_MS) {
                    try {
                        unlinkSync(markerPath);
                    }
                    catch {
                        // Keep expired markers out of the send window even if cleanup races or fails.
                    }
                    emitReceiptEvent(context, 'pruned_expired', deliveryRef, 'client_retention');
                    continue;
                }
                emitReceiptEvent(context, 'marker_read', deliveryRef);
                live.push({ deliveryRef, modifiedAt: marker.mtimeMs });
            }
            catch {
                // A marker removed concurrently is already in the desired state.
            }
        }
        return live
            .sort((left, right) => right.modifiedAt - left.modifiedAt || right.deliveryRef.localeCompare(left.deliveryRef))
            .slice(0, MAX_PENDING_REFS)
            .map(({ deliveryRef }) => deliveryRef);
    }
    catch {
        return [];
    }
}
export function reportJitDeliveryRefsAttached(deliveryRefs, context) {
    for (const deliveryRef of new Set(deliveryRefs)) {
        if (DELIVERY_REF_RE.test(deliveryRef)) {
            emitReceiptEvent(context, 'attached_to_request', deliveryRef);
        }
    }
}
/** Remove only references the server says were valid or safe duplicates. */
export function acknowledgeJitDeliveryRefs(directory, deliveryRefs, context) {
    for (const deliveryRef of new Set(deliveryRefs)) {
        if (!DELIVERY_REF_RE.test(deliveryRef))
            continue;
        emitReceiptEvent(context, 'marker_confirmed', deliveryRef);
        try {
            unlinkSync(join(directory, deliveryRef));
        }
        catch {
            // Missing/locked marker: retrying is harmless and bounded by server TTL.
        }
    }
}
/** Remove references the server can no longer accept instead of retrying forever. */
export function pruneExpiredJitDeliveryRefs(directory, deliveryRefs, context) {
    for (const deliveryRef of new Set(deliveryRefs)) {
        if (!DELIVERY_REF_RE.test(deliveryRef))
            continue;
        try {
            unlinkSync(join(directory, deliveryRef));
        }
        catch {
            // Missing/locked marker: the ordinary client-retention sweep remains a backstop.
        }
        emitReceiptEvent(context, 'pruned_expired', deliveryRef, 'server_unknown_or_expired');
    }
}
/** Apply only receipt outcomes correlated to the exact refs on this request. */
export function applyJitDeliveryReceiptResponse(directory, attachedDeliveryRefs, response, context) {
    const attached = new Set(attachedDeliveryRefs);
    acknowledgeJitDeliveryRefs(directory, (response.confirmedDeliveryRefs ?? []).filter((deliveryRef) => attached.has(deliveryRef)), context);
    pruneExpiredJitDeliveryRefs(directory, (response.discardedDeliveryRefs ?? []).filter((deliveryRef) => attached.has(deliveryRef)), context);
}
//# sourceMappingURL=jitDeliveryAck.js.map