/**
 * Per-URI sequencing for document validations.
 *
 * A document is validated repeatedly: every edit, every save, and every
 * configuration change starts another check, and a check that was already
 * running when a newer one starts is cancelled but not necessarily finished.
 * A result may only be published while it is still the newest one issued for
 * its URI.
 *
 * Generations come from a process-wide monotonic counter and are never
 * recycled, which is what makes a second execution distinguishable from the
 * first: a result produced before a document was closed can never satisfy the
 * current-check test for the same URI after the document is reopened, because
 * the reopened document is issued a strictly higher generation.
 */
export interface ValidationHandle {
    /** Process-unique, never-reused number identifying this validation attempt. */
    readonly generation: number;
    /** True while no newer validation has been started for this URI. */
    isCurrent(): boolean;
}
export declare class ValidationSequencer {
    /** Newest generation issued per URI; a URI absent here has no live validation. */
    private latest;
    private issued;
    /** Issues a handle for a new validation of `uri`, superseding earlier ones. */
    begin(uri: string): ValidationHandle;
    /**
     * Retires every handle for `uri` without issuing a replacement, so a check
     * still in flight for a closed document can no longer publish. A later
     * `begin` for the same URI gets a higher generation and publishes again.
     */
    close(uri: string): void;
}
//# sourceMappingURL=validation-state.d.ts.map