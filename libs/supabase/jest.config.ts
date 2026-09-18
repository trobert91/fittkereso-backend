export default {
  displayName: 'supabase',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  // jose is ESM-only and unreachable from Jest's CommonJS runtime. It arrives
  // transitively through the supabase barrel; see jest/jose-mock.js.
  moduleNameMapper: {
    '^jose$': '<rootDir>/../../jest/jose-mock.js',
  },
  coverageDirectory: '../../coverage/libs/supabase',
};
