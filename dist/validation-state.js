"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationSequencer = void 0;
class ValidationSequencer {
    /** Newest generation issued per URI; a URI absent here has no live validation. */
    latest = new Map();
    issued = 0;
    /** Issues a handle for a new validation of `uri`, superseding earlier ones. */
    begin(uri) {
        const generation = ++this.issued;
        this.latest.set(uri, generation);
        return {
            generation,
            isCurrent: () => this.latest.get(uri) === generation,
        };
    }
    /**
     * Retires every handle for `uri` without issuing a replacement, so a check
     * still in flight for a closed document can no longer publish. A later
     * `begin` for the same URI gets a higher generation and publishes again.
     */
    close(uri) {
        this.latest.delete(uri);
    }
}
exports.ValidationSequencer = ValidationSequencer;
//# sourceMappingURL=validation-state.js.map