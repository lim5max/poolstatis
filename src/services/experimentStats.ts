export interface VariantOutcome {
  key: string;
  exposed: number;
  converted: number;
}

export interface VariantExperimentStats extends VariantOutcome {
  conversion_rate: number;
  uplift_vs_control: number | null;
  credible_interval: { lower: number; upper: number };
  probability_best: number;
}

/**
 * A deterministic Bayesian summary for conversion experiments. A seeded sampler
 * keeps output stable for agents, test snapshots and repeat reads of unchanged
 * data while retaining the intuitive probability-of-winning interpretation.
 */
export function summarizeExperimentVariants(
  outcomes: VariantOutcome[],
  draws = 10_000,
): VariantExperimentStats[] {
  if (outcomes.length === 0) return [];
  const random = mulberry32(seedFor(outcomes));
  const samples = outcomes.map((outcome) => {
    const alpha = outcome.converted + 1;
    const beta = outcome.exposed - outcome.converted + 1;
    return Array.from({ length: draws }, () => betaSample(alpha, beta, random));
  });
  const wins = Array<number>(outcomes.length).fill(0);
  for (let draw = 0; draw < draws; draw++) {
    let winner = 0;
    for (let variant = 1; variant < samples.length; variant++) {
      if (samples[variant]![draw]! > samples[winner]![draw]!) winner = variant;
    }
    wins[winner]! += 1;
  }
  const controlRate = rate(outcomes[0]!);
  return outcomes.map((outcome, index) => {
    const sorted = [...samples[index]!].sort((a, b) => a - b);
    const conversionRate = rate(outcome);
    return {
      ...outcome,
      conversion_rate: conversionRate,
      uplift_vs_control: index === 0 || controlRate === 0 ? null : round((conversionRate - controlRate) / controlRate),
      credible_interval: {
        lower: round(quantile(sorted, 0.025)),
        upper: round(quantile(sorted, 0.975)),
      },
      probability_best: round(wins[index]! / draws),
    };
  });
}

function rate(outcome: VariantOutcome): number {
  return outcome.exposed === 0 ? 0 : round(outcome.converted / outcome.exposed);
}

function quantile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!;
}

function betaSample(alpha: number, beta: number, random: () => number): number {
  const a = gammaSample(alpha, random);
  const b = gammaSample(beta, random);
  return a / (a + b);
}

function gammaSample(shape: number, random: () => number): number {
  if (shape < 1) return gammaSample(shape + 1, random) * Math.pow(random(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    const x = normalSample(random);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalSample(random: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function seedFor(outcomes: VariantOutcome[]): number {
  let hash = 2_166_136_261;
  for (const char of JSON.stringify(outcomes)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed += 0x6D2B79F5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
