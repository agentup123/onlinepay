/**
 * Pure transaction-monitoring rules (easy to unit test and tune). These are a starting point
 * for the AML programme — thresholds must be agreed with your MLRO and NymCard.
 */
export interface MonitoringConfig {
  highAmountFils: number;
  velocityCount: number; // authorizations per 10 minutes
  declineCount: number; // declines per hour
  riskyMccs: string[];
}

export interface TxnFacts {
  amountFils: number;
  mcc?: string;
  stage: string;
  authsLast10Min: number;
  declinesLastHour: number;
}

export type RuleHit = {
  rule: 'HIGH_AMOUNT' | 'VELOCITY' | 'DECLINES' | 'RISKY_MCC';
  details: Record<string, unknown>;
};

export function evaluateRules(f: TxnFacts, cfg: MonitoringConfig): RuleHit[] {
  const hits: RuleHit[] = [];
  if (f.amountFils >= cfg.highAmountFils) {
    hits.push({
      rule: 'HIGH_AMOUNT',
      details: { amountFils: f.amountFils, threshold: cfg.highAmountFils },
    });
  }
  if (f.stage === 'AUTHORIZATION' && f.authsLast10Min > cfg.velocityCount) {
    hits.push({
      rule: 'VELOCITY',
      details: { authsLast10Min: f.authsLast10Min, threshold: cfg.velocityCount },
    });
  }
  if (f.stage === 'DECLINE' && f.declinesLastHour >= cfg.declineCount) {
    hits.push({
      rule: 'DECLINES',
      details: { declinesLastHour: f.declinesLastHour, threshold: cfg.declineCount },
    });
  }
  if (f.mcc && cfg.riskyMccs.includes(f.mcc)) {
    hits.push({ rule: 'RISKY_MCC', details: { mcc: f.mcc } });
  }
  return hits;
}
