// Seeded scenario identity, recomputed from the kit's wire.ts buildScenario()
// (SCENARIO_SEED 0x6a09e667f3bcc909). Fixed across practice and final trials.
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;
export const STRANGER = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' } as const;
export const TEAMMATE = { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' } as const;
// Fixed timestamp for every REST-created commit / created_at field: deterministic
// across live and replay runs. 2025-01-01T00:00:00Z.
export const FIXED_EPOCH = 1735689600;
export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const DEFAULT_BRANCH = 'main';
