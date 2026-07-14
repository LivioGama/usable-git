export type ConfidenceInterval = {
  confidence: 0.95;
  low: number;
  high: number;
  resamples: number;
};

export type MetricSummary = {
  median: number;
  p95: number;
  medianCi: ConfidenceInterval;
  p95Ci: ConfidenceInterval;
};

type BootstrapOptions = {
  seed: number;
  resamples?: number;
  statistic: (values: number[]) => number;
};

const assertValues = (values: number[]) => {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("statistics require at least one finite value");
  }
};

const createRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

export const percentile = (values: number[], quantile: number) => {
  assertValues(values);
  if (quantile < 0 || quantile > 1) throw new Error("quantile must be between 0 and 1");
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower] as number;
  const upperValue = sorted[upper] as number;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
};

export const bootstrapConfidenceInterval = (
  values: number[],
  { seed, resamples = 2_000, statistic }: BootstrapOptions,
): ConfidenceInterval => {
  assertValues(values);
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new Error("resamples must be a positive integer");
  }
  const random = createRandom(seed);
  const statistics = Array.from({ length: resamples }, () => {
    const sample = Array.from(
      { length: values.length },
      () => values[Math.floor(random() * values.length)] as number,
    );
    return statistic(sample);
  });
  return {
    confidence: 0.95,
    low: percentile(statistics, 0.025),
    high: percentile(statistics, 0.975),
    resamples,
  };
};

export const summarizeMetric = (values: number[], seed: number): MetricSummary => ({
  median: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  medianCi: bootstrapConfidenceInterval(values, {
    seed,
    statistic: (sample) => percentile(sample, 0.5),
  }),
  p95Ci: bootstrapConfidenceInterval(values, {
    seed: seed ^ 0x9e3779b9,
    statistic: (sample) => percentile(sample, 0.95),
  }),
});
