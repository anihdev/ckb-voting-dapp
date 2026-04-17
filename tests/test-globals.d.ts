/**
 * Test Runner Editor Declarations
 * ===============================
 * Keeps the root TypeScript project quiet in editors without relying on
 * workspace-package type resolution for Jest or Vitest.
 */

declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => any;

declare module "vitest" {
  export const describe: (name: string, fn: () => void) => void;
  export const test: (name: string, fn: () => void) => void;
  export const expect: (value: unknown) => any;
}
