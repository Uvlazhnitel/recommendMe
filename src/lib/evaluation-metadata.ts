import { createHash } from 'node:crypto';
import type { Usage } from './openai';

export const ALGORITHM_ID = 'recommendme-2.0-candidates-v2-audit1';
export type StageEvaluation = {
  algorithm_id: string; candidate_selection: string; git_sha: string;
  profile_version: number; profile_prompt_version: number; profile_schema_version: number;
  prompt_sha256: string; format_sha256: string; model: string | null; usage: Usage | null;
};
export function stageEvaluation(input: { role: string; content: string }[], format: unknown,
  profile: { profile_version: number; profile_prompt_version: number; profile_schema_version: number }): StageEvaluation {
  const sha = process.env.APP_GIT_SHA ?? '';
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { algorithm_id: ALGORITHM_ID, candidate_selection: 'candidates-v2-audit1', git_sha: /^[a-f0-9]{40}$/.test(sha) ? sha : 'unknown',
    profile_version: profile.profile_version, profile_prompt_version: profile.profile_prompt_version, profile_schema_version: profile.profile_schema_version,
    prompt_sha256: hash(input.filter(row => row.role === 'system')), format_sha256: hash(format), model: null, usage: null };
}
