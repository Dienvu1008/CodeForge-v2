// Dependency direction enforcement — INVARIANTS.md DC-001..DC-005.
// Domain (agent-core) must not depend on infrastructure/models/tools.
// verification/recovery must not depend on models.
module.exports = {
  forbidden: [
    {
      name: 'no-domain-to-infrastructure',
      comment: 'DC-001/DC-003: agent-core (domain) must not import infrastructure.',
      severity: 'error',
      from: { path: '^packages/agent-core' },
      to: { path: '^packages/infrastructure' },
    },
    {
      name: 'no-domain-to-models',
      comment: 'DC-003: agent-core must not import models.',
      severity: 'error',
      from: { path: '^packages/agent-core' },
      to: { path: '^packages/models' },
    },
    {
      name: 'no-domain-to-tools',
      comment: 'DC-003: agent-core must not import tools.',
      severity: 'error',
      from: { path: '^packages/agent-core' },
      to: { path: '^packages/tools' },
    },
    {
      name: 'no-verification-to-models',
      comment: 'DC-004: verification must not import models.',
      severity: 'error',
      from: { path: '^packages/verification' },
      to: { path: '^packages/models' },
    },
    {
      name: 'no-recovery-to-models',
      comment: 'DC-005: recovery must not import models directly (only via interface).',
      severity: 'error',
      from: { path: '^packages/recovery' },
      to: { path: '^packages/models' },
    },
    {
      name: 'no-circular',
      comment: 'No circular dependencies between modules.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'node'],
    },
  },
};
