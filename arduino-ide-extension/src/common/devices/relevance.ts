/**
 * MOD-06 — Update Relevance Checker.
 *
 * Guards against flashing a sketch onto a board it was not written for. The
 * score is the fraction of the device's profile that the sketch's tags cover:
 *
 *     score = |sketch_tags ∩ device_profile| / |device_profile|
 *
 * Note the denominator is the *device* profile, so the question asked is "how
 * much of what this device is does this sketch acknowledge" — a sketch with
 * many irrelevant extra tags is not penalised, but one that ignores what the
 * device actually is scores low.
 */

export const RELEVANCE_THRESHOLD = 0.3;

export type RelevanceVerdict = 'proceed' | 'warn' | 'strong-warning';

export interface RelevanceResult {
  readonly score: number;
  readonly verdict: RelevanceVerdict;
  readonly matched: string[];
  readonly missing: string[];
}

function normalize(values: readonly string[]): Set<string> {
  return new Set(
    values
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
  );
}

export function assessRelevance(
  sketchTags: readonly string[],
  deviceProfile: readonly string[],
  threshold: number = RELEVANCE_THRESHOLD
): RelevanceResult {
  const tags = normalize(sketchTags);
  const profile = normalize(deviceProfile);

  // An empty profile means nothing is known about the device. Blocking on no
  // information would make the checker fire on every unprofiled board, so the
  // absence of a profile is treated as no objection.
  if (profile.size === 0) {
    return { score: 1, verdict: 'proceed', matched: [], missing: [] };
  }

  const matched: string[] = [];
  const missing: string[] = [];
  for (const entry of profile) {
    (tags.has(entry) ? matched : missing).push(entry);
  }

  const score = matched.length / profile.size;

  let verdict: RelevanceVerdict;
  if (score === 0) {
    verdict = 'strong-warning';
  } else if (score >= threshold) {
    verdict = 'proceed';
  } else {
    verdict = 'warn';
  }

  return { score, verdict, matched: matched.sort(), missing: missing.sort() };
}
