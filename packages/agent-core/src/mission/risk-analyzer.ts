// RiskAnalyzer — Phase 12 (P12.2). Deterministic risk assessment over objective keyword
// dimensions (§6). This component only RECOMMENDS what should be required — the existing
// approval/policy system (ToolPolicy, ApprovalCoordinator) stays authoritative (MI-001).
import type { RiskAssessment, RiskDimension, RiskLevel } from '../domain/mission.js';
import type { MissionSignals } from './signals.js';

interface DimRule {
  readonly dim: RiskDimension;
  readonly keywords: readonly string[];
  /** Severity weight this dimension contributes to the overall level. */
  readonly weight: number;
}

// Ordered dimension rules. Weights drive the final RiskLevel; keywords are substring matches.
const DIMENSIONS: readonly DimRule[] = [
  { dim: 'DESTRUCTIVE',       weight: 4, keywords: ['delete', 'drop table', 'rm -rf', 'remove all', 'wipe', 'destroy', 'truncate'] },
  { dim: 'DEPLOYMENT',        weight: 3, keywords: ['deploy', 'release', 'publish', 'production', 'rollout'] },
  { dim: 'CREDENTIAL',        weight: 3, keywords: ['secret', 'token', 'api key', 'apikey', 'password', 'credential', 'auth token', '.env'] },
  { dim: 'SECURITY_SENSITIVE',weight: 3, keywords: ['auth', 'authentication', 'authorization', 'permission', 'security', 'encryption', 'crypto'] },
  { dim: 'SYSTEM_CHANGE',     weight: 3, keywords: ['install', 'uninstall', 'system', 'registry', 'environment variable', 'global config'] },
  { dim: 'DATABASE',          weight: 2, keywords: ['database', 'migration', 'schema', 'sql', 'sqlite', 'postgres', 'mysql'] },
  { dim: 'EXTERNAL_SERVICE',  weight: 2, keywords: ['third-party', 'external service', 'webhook', 'remote api', 'cloud'] },
  { dim: 'NETWORK',           weight: 2, keywords: ['network', 'http', 'fetch', 'download', 'telegram', 'github api', 'request to'] },
  { dim: 'BUILD',             weight: 1, keywords: ['build', 'compile', 'bundle', 'package'] },
  { dim: 'LOCAL_EDIT',        weight: 1, keywords: ['edit', 'change', 'modify', 'update', 'rename', 'add', 'implement', 'fix', 'refactor'] },
];

const APPROVAL_DIMS: ReadonlySet<RiskDimension> = new Set<RiskDimension>([
  'DESTRUCTIVE', 'DEPLOYMENT', 'CREDENTIAL', 'SYSTEM_CHANGE', 'SECURITY_SENSITIVE',
]);

/**
 * Assess risk deterministically. Collects matched dimensions, derives the level from the
 * maximum weight (plus a small bump when several high-weight dimensions co-occur), and
 * recommends which dimensions SHOULD require approval + verification.
 */
export function assessRisk(signals: MissionSignals): RiskAssessment {
  const factors: RiskDimension[] = [];
  let maxWeight = 0;
  let highCount = 0;
  for (const rule of DIMENSIONS) {
    if (rule.keywords.some((kw) => signals.text.includes(kw))) {
      factors.push(rule.dim);
      maxWeight = Math.max(maxWeight, rule.weight);
      if (rule.weight >= 3) highCount++;
    }
  }

  // READ_ONLY when nothing mutating matched at all.
  if (factors.length === 0) {
    return {
      level: 'LOW',
      factors: ['READ_ONLY'],
      requiredApprovals: [],
      requiredVerification: [],
    };
  }

  let level: RiskLevel;
  if (maxWeight >= 4) level = 'CRITICAL';
  else if (maxWeight >= 3) level = highCount >= 2 ? 'CRITICAL' : 'HIGH';
  else if (maxWeight >= 2) level = 'MEDIUM';
  else level = 'LOW';

  const requiredApprovals = factors.filter((f) => APPROVAL_DIMS.has(f));
  const requiredVerification: string[] = [];
  if (factors.includes('BUILD') || factors.includes('LOCAL_EDIT')) requiredVerification.push('build/test must pass');
  if (factors.includes('NETWORK') || factors.includes('EXTERNAL_SERVICE')) requiredVerification.push('integration/config validation');
  if (factors.includes('DATABASE')) requiredVerification.push('migration verified / reversible');

  return {
    level,
    factors: [...new Set(factors)].sort(),
    requiredApprovals: [...new Set(requiredApprovals)].sort(),
    requiredVerification: [...new Set(requiredVerification)].sort(),
  };
}
