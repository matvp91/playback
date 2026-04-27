import { describe, expect, it } from "vitest";
import { ThroughputEstimator } from "../../lib/abr/throughput_estimator";
import type { AbrConfig } from "../../lib/config";

const TEST_CONFIG: AbrConfig = {
  defaultBandwidthEstimate: 1_000_000,
  bandwidthUpgradeTarget: 0.7,
  bandwidthDowngradeTarget: 0.95,
  evaluationInterval: 8,
  fastHalfLife: 3,
  slowHalfLife: 9,
  minTotalBytes: 128_000,
};

describe("ThroughputEstimator", () => {
  it("returns null before any sample", () => {
    const est = new ThroughputEstimator(TEST_CONFIG);
    expect(est.getEstimate()).toBeNull();
  });

  it("ignores invalid samples", () => {
    const est = new ThroughputEstimator(TEST_CONFIG);
    est.sample(0, 100_000);
    est.sample(-1, 100_000);
    est.sample(1, 0);
    est.sample(1, -100);
    expect(est.getEstimate()).toBeNull();
  });

  it("returns null while totalBytes < minTotalBytes", () => {
    const est = new ThroughputEstimator(TEST_CONFIG);
    // 64 KB worth of samples — under the 128 KB threshold.
    est.sample(1, 64_000);
    expect(est.getEstimate()).toBeNull();
  });

  it("returns min(fast, slow) once over the threshold", () => {
    const est = new ThroughputEstimator(TEST_CONFIG);
    // Steady 8 Mbps over enough bytes to clear minTotalBytes.
    // Each sample: 1MB in 1s = 8 Mbps; 200 KB chunks for granularity.
    for (let i = 0; i < 10; i++) {
      est.sample(0.2, 200_000);
    }
    const estimate = est.getEstimate();
    expect(estimate).not.toBeNull();
    // At steady ~8 Mbps with the same input to both Ewmas, both
    // return ~8e6, so min is also ~8e6.
    expect(estimate).toBeGreaterThan(7_500_000);
    expect(estimate).toBeLessThan(8_500_000);
  });

  it("fast EWMA drops faster than slow on a sudden bandwidth dip", () => {
    const est = new ThroughputEstimator(TEST_CONFIG);
    // Prime with steady 8 Mbps for plenty of samples.
    for (let i = 0; i < 20; i++) {
      est.sample(0.2, 200_000);
    }
    const before = est.getEstimate()!;
    // Sudden dip to 1 Mbps for a few samples (each: 125 KB in 1s = 1 Mbps).
    for (let i = 0; i < 5; i++) {
      est.sample(1, 125_000);
    }
    const after = est.getEstimate()!;
    expect(after).toBeLessThan(before);
    // min(fast, slow) should reflect the dip — fast reacts in seconds.
    expect(after).toBeLessThan(5_000_000);
  });
});
