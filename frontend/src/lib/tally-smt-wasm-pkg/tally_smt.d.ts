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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_tallysmtprovider_free: (a: number, b: number) => void;
    readonly tallysmtprovider_compile_transition_proof: (a: number, b: number, c: number) => any;
    readonly tallysmtprovider_insert_present: (a: number, b: any) => void;
    readonly tallysmtprovider_new: () => number;
    readonly tallysmtprovider_root: (a: number) => any;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
