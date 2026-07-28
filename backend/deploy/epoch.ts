/**
 * CKB Epoch Helpers
 * =================
 * Normalizes CCC Epoch objects and legacy epoch encodings used by deployment
 * and smoke tooling.
 */

import { ccc } from "@ckb-ccc/core";

export type EpochParts = {
  integer: bigint;
  numerator: bigint;
  denominator: bigint;
};

/** @notice Decodes an epoch without relying on the old tuple-only client shape. */
export function epochParts(epochLike: any): EpochParts {
  const normalized =
    typeof epochLike === "string" && epochLike.includes(",")
      ? epochLike.split(",").slice(0, 3)
      : epochLike;
  try {
    const epoch = (ccc as any).Epoch.from(normalized);
    return {
      integer: BigInt(epoch.integer),
      numerator: BigInt(epoch.numerator),
      denominator: BigInt(epoch.denominator),
    };
  } catch {
    throw new Error("CKB client returned an invalid epoch value");
  }
}

/** @notice Returns only the integer component used by governance deadlines. */
export function epochNumber(epochLike: any): bigint {
  return epochParts(epochLike).integer;
}
