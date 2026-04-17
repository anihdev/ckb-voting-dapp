/**
 * Backend Contract Jest Config
 * ============================
 * Keeps ts-jest resolution local to the contract package workspace.
 */

module.exports = {
  testEnvironment: "node",
  rootDir: "../..",
  testMatch: ["**/tests/contract.test.ts"],
  transform: {
    "^.+\\.tsx?$": [
      require.resolve("ts-jest"),
      {
        tsconfig: {
          target: "ES2020",
          module: "commonjs",
          esModuleInterop: true,
          strict: false,
          types: ["node", "jest"],
        },
      },
    ],
  },
};
