/* tslint:disable */
/* eslint-disable */

export class TallySmtProvider {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Build one compiled non-membership/update multiproof for the pending keys.
     * The CKB contract replays it against zero old leaves and present new leaves.
     */
    compile_transition_proof(keys: Uint8Array[]): Uint8Array;
    /**
     * Insert one already-counted represented voter while reconstructing a lane.
     */
    insert_present(key: Uint8Array): void;
    constructor();
    root(): Uint8Array;
}
