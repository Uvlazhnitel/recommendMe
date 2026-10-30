import { userId } from '../src/lib/profiles';
import { loadEnvConfig } from '@next/env';
import { parseArgs } from 'node:util';
import { openDatabase } from '../src/lib/db';
import { evaluationPeriod, evaluationReport, formatEvaluationReport } from '../src/lib/evaluation-report';

try {
  const { values } = parseArgs({ options: { user: { type: 'string' }, json: { type: 'boolean' }, from: { type: 'string' }, to: { type: 'string' } }, strict: true });
  const profileId = userId(values.user);
  const period = { from: values.from, to: values.to };
  evaluationPeriod(period);
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
  const db = openDatabase({ readonly: true });
  try {
    const report = db.transaction(() => evaluationReport(db, profileId, period)).deferred();
    console.log(values.json ? JSON.stringify(report, null, 2) : formatEvaluationReport(report));
  } finally { db.close(); }
} catch (error) { console.error(error instanceof Error ? error.message : 'Evaluation report failed.'); process.exitCode = 1; }
