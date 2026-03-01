// jest.config.js (project root)
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["**/tests/**/*.test.ts"],
  moduleNameMapper: {
    // Allow importing from backend and frontend
    "^@/(.*)$": "<rootDir>/frontend/src/$1",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { strict: false } }],
  },
};