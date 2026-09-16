export declare function normalizeJitHookVersion(hookVersion: unknown): string;
export type JitReceiptClientEventName = 'marker_persisted' | 'marker_read' | 'attached_to_request' | 'marker_confirmed' | 'pruned_expired';
export interface JitReceiptClientEvent {
    mnemonik_marker: 'jit_receipt_client';
    event: JitReceiptClientEventName;
    deliveryRefHash: string;
    sessionFingerprint: string;
    hookVersion: string;
    reason?: 'client_retention' | 'server_unknown_or_expired';
}
export interface JitReceiptEventContext {
    sessionId: string;
    hookVersion: string;
    /** Test seam; production writes one JSON event per line to hook stderr. */
    emit?: (event: JitReceiptClientEvent) => void;
}
/** Persist only after the final host-visible payload contains this JIT result. */
export declare function persistJitDeliveryRef(directory: string, deliveryRef: string, context?: JitReceiptEventContext): boolean;
export declare function readPendingJitDeliveryRefs(directory: string, context?: JitReceiptEventContext): string[];
export declare function reportJitDeliveryRefsAttached(deliveryRefs: string[], context?: JitReceiptEventContext): void;
/** Remove only references the server says were valid or safe duplicates. */
export declare function acknowledgeJitDeliveryRefs(directory: string, deliveryRefs: string[], context?: JitReceiptEventContext): void;
/** Remove references the server can no longer accept instead of retrying forever. */
export declare function pruneExpiredJitDeliveryRefs(directory: string, deliveryRefs: string[], context?: JitReceiptEventContext): void;
/** Apply only receipt outcomes correlated to the exact refs on this request. */
export declare function applyJitDeliveryReceiptResponse(directory: string, attachedDeliveryRefs: string[], response: {
    confirmedDeliveryRefs?: string[];
    discardedDeliveryRefs?: string[];
}, context?: JitReceiptEventContext): void;
//# sourceMappingURL=jitDeliveryAck.d.ts.map