import type { AbrConfig } from "../config";

/**
 * Weighted exponentially-weighted moving average with bias correction.
 * Math unchanged from the previous `lib/abr/ewma.ts`.
 */
class Ewma {
  private alpha_: number;
  private estimate_ = 0;
  private totalWeight_ = 0;

  constructor(halfLife: number) {
    // Convert half-life to a per-unit-time decay factor in (0, 1).
    this.alpha_ = 0.5 ** (1 / halfLife);
  }

  sample(weight: number, value: number) {
    const adjAlpha = this.alpha_ ** weight;
    const newEstimate = value * (1 - adjAlpha) + adjAlpha * this.estimate_;
    if (!Number.isNaN(newEstimate)) {
      this.estimate_ = newEstimate;
      this.totalWeight_ += weight;
    }
  }

  getEstimate(): number {
    const zeroFactor = 1 - this.alpha_ ** this.totalWeight_;
    return this.estimate_ / zeroFactor;
  }
}

/**
 * Dual-EWMA throughput estimator. Samples bandwidth from
 * `(durationSeconds, bytes)` and reports the conservative estimate
 * `min(fast, slow)` once `totalBytes >= config.minTotalBytes`.
 *
 * Returns `null` while undersampled — caller decides what to do
 * (typically falling back to `config.defaultBandwidthEstimate`).
 */
export class ThroughputEstimator {
  private fast_: Ewma;
  private slow_: Ewma;
  private totalBytes_ = 0;
  private config_: AbrConfig;

  constructor(config: AbrConfig) {
    this.config_ = config;
    this.fast_ = new Ewma(config.fastHalfLife);
    this.slow_ = new Ewma(config.slowHalfLife);
  }

  sample(durationSeconds: number, bytes: number) {
    if (durationSeconds <= 0 || bytes <= 0) {
      return;
    }
    const bitsPerSecond = (bytes * 8) / durationSeconds;
    this.fast_.sample(durationSeconds, bitsPerSecond);
    this.slow_.sample(durationSeconds, bitsPerSecond);
    this.totalBytes_ += bytes;
  }

  /**
   * Returns the conservative throughput estimate in bits/second, or
   * `null` while `totalBytes_ < config_.minTotalBytes` (insufficient
   * data for the EWMA to be trustworthy).
   */
  getEstimate(): number | null {
    if (this.totalBytes_ < this.config_.minTotalBytes) {
      return null;
    }
    return Math.min(this.fast_.getEstimate(), this.slow_.getEstimate());
  }
}
