/**
 * kelly-sizer.ts
 * --------------
 * Kelly Criterion position sizing for prediction market trading bots.
 *
 * The current API gives bots a direction + confidence but no bet size.
 * Without sizing, bots either flat-bet (suboptimal) or improvise (dangerous).
 *
 * Kelly formula:  f* = (p·b − (1−p)) / b
 *   p = calibrated win probability
 *   b = net odds = (1 − yesPrice) / yesPrice
 *   f* = optimal fraction of bankroll to wager
 *
 * We default to quarter-Kelly (f* × 0.25) which:
 *   - Retains ~94% of the long-run growth rate
 *   - Reduces variance by 75%
 *   - Is standard practice for volatile, correlated markets
 */

import type { Market } from '../types/market';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KellyInput {
  /** Calibrated win probability (0–1). Use calibrated_probability from analyze-text. */
  probability: number;
  /** Current YES price on the market (0–1) */
  yesPrice: number;
  /** Bot's current bankroll in USD */
  bankroll: number;
  /** Trading direction */
  direction: "YES" | "NO";
  /** Kelly fraction multiplier. Default 0.25 (quarter-Kelly). */
  kellyFraction?: number;
  /**
   * Hard cap: maximum fraction of bankroll on any single trade.
   * Default 0.05 (5%). Kelly can suggest more; this overrides it.
   */
  maxSingleBetFraction?: number;
  /**
   * Absolute max USD bet regardless of bankroll.
   * Useful for bots with large bankrolls.
   */
  maxAbsoluteBet?: number;
  /**
   * Scale down factor when data is stale.
   * Pass data_age_seconds from API metadata.
   */
  dataAgeSeconds?: number;
}

export interface KellySizing {
  /** Raw Kelly fraction (may be negative — means no edge) */
  kelly_fraction: number;
  /** Recommended fraction after applying kellyFraction multiplier and caps */
  recommended_fraction: number;
  /** Recommended USD amount to bet */
  recommended_amount: number;
  /** Net odds used in calculation */
  net_odds: number;
  /** Expected value of the recommended bet in USD */
  expected_value: number;
  /** Maximum possible loss on this position */
  max_loss: number;
  /** Human-readable explanation of the sizing decision */
  reasoning: string;
  /** Warnings about edge cases or risk factors */
  warnings: string[];
  /** Whether there is a positive edge (kelly_fraction > 0) */
  has_edge: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_KELLY_FRACTION = 0.25;
const DEFAULT_MAX_SINGLE_BET = 0.05; // 5% of bankroll
const DEFAULT_MAX_ABSOLUTE_BET = Infinity;

/** Data older than this triggers a 50% size reduction */
const STALE_DATA_THRESHOLD_SECONDS = 20;

/** Minimum probability to consider acting (below this, Kelly is negative) */
const MIN_ACTIONABLE_PROBABILITY = 0.5;

// ─── Core calculation ─────────────────────────────────────────────────────────

/**
 * Computes net odds from a YES price.
 *
 * At YES = 0.60: you risk $0.60 to win $0.40 net.
 * Net odds b = 0.40 / 0.60 = 0.667
 *
 * For NO direction: the "YES price" for Kelly is (1 - yesPrice).
 */
export function netOdds(yesPrice: number, direction: "YES" | "NO"): number {
  const effectivePrice = direction === "YES" ? yesPrice : 1 - yesPrice;
  return (1 - effectivePrice) / effectivePrice;
}

/**
 * Core Kelly formula.
 * Returns the optimal fraction of bankroll to bet.
 * Negative return = no edge, don't bet.
 */
export function fullKelly(probability: number, netOddsB: number): number {
  return (probability * netOddsB - (1 - probability)) / netOddsB;
}

/**
 * Computes expected value of a bet as a fraction of bet size.
 * EV = p * winnings_per_unit - (1-p) * 1
 */
export function expectedValueFraction(probability: number, netOddsB: number): number {
  return probability * netOddsB - (1 - probability);
}

/**
 * Main position sizing function.
 *
 * Usage:
 *   const sizing = kellySize({
 *     probability: signal.calibrated_probability,  // from analyze-text
 *     yesPrice: market.yesPrice,
 *     bankroll: 1000,
 *     direction: signal.suggested_action.direction,
 *     dataAgeSeconds: metadata.data_age_seconds,
 *   });
 *
 *   if (sizing.has_edge) {
 *     placeBet(sizing.recommended_amount);
 *   }
 */
export function kellySize(input: KellyInput): KellySizing {
  const {
    probability,
    yesPrice,
    bankroll,
    direction,
    kellyFraction = DEFAULT_KELLY_FRACTION,
    maxSingleBetFraction = DEFAULT_MAX_SINGLE_BET,
    maxAbsoluteBet = DEFAULT_MAX_ABSOLUTE_BET,
    dataAgeSeconds = 0,
  } = input;

  const warnings: string[] = [];

  // Validate inputs
  if (probability < 0 || probability > 1) {
    throw new Error(`probability must be in [0,1], got ${probability}`);
  }
  if (yesPrice <= 0 || yesPrice >= 1) {
    throw new Error(`yesPrice must be in (0,1), got ${yesPrice}`);
  }
  if (bankroll <= 0) {
    throw new Error(`bankroll must be positive, got ${bankroll}`);
  }

  const b = netOdds(yesPrice, direction);
  const f_full = fullKelly(probability, b);
  const hasEdge = f_full > 0;

  if (!hasEdge) {
    return {
      kelly_fraction: Number(f_full.toFixed(4)),
      recommended_fraction: 0,
      recommended_amount: 0,
      net_odds: Number(b.toFixed(4)),
      expected_value: 0,
      max_loss: 0,
      reasoning: `No edge detected. Kelly f*=${(f_full * 100).toFixed(1)}% (negative means expected loss at current probability ${(probability * 100).toFixed(0)}% and price ${yesPrice}).`,
      warnings: [`Implied market probability is ${((direction === "YES" ? yesPrice : 1 - yesPrice) * 100).toFixed(0)}%, your estimate is ${(probability * 100).toFixed(0)}% — insufficient edge.`],
      has_edge: false,
    };
  }

  // Apply Kelly fraction multiplier
  let f_recommended = f_full * kellyFraction;

  // Apply hard caps
  const capFromFraction = maxSingleBetFraction;
  if (f_recommended > capFromFraction) {
    warnings.push(
      `Full Kelly (${(f_full * 100).toFixed(1)}%) × ${kellyFraction} = ${(f_recommended * 100).toFixed(1)}% exceeds single-bet cap of ${(capFromFraction * 100).toFixed(0)}%. Capped.`
    );
    f_recommended = capFromFraction;
  }

  let recommendedAmount = f_recommended * bankroll;

  if (recommendedAmount > maxAbsoluteBet) {
    warnings.push(`Bet capped at absolute max $${maxAbsoluteBet}.`);
    recommendedAmount = maxAbsoluteBet;
    f_recommended = recommendedAmount / bankroll;
  }

  // Stale data penalty: halve position size if data is old
  if (dataAgeSeconds > STALE_DATA_THRESHOLD_SECONDS) {
    warnings.push(
      `Data is ${dataAgeSeconds}s old (threshold: ${STALE_DATA_THRESHOLD_SECONDS}s). Reducing position by 50%.`
    );
    recommendedAmount *= 0.5;
    f_recommended *= 0.5;
  }

  // Round to cents
  recommendedAmount = Math.floor(recommendedAmount * 100) / 100;

  const ev = expectedValueFraction(probability, b);
  const expectedValueUSD = ev * recommendedAmount;

  const effectivePrice = direction === "YES" ? yesPrice : 1 - yesPrice;
  const reasoning =
    `p=${(probability * 100).toFixed(0)}%, b=${b.toFixed(3)} (price=${effectivePrice}) ` +
    `→ full Kelly f*=${(f_full * 100).toFixed(1)}%, ` +
    `${(kellyFraction * 100).toFixed(0)}%-Kelly=${(f_full * kellyFraction * 100).toFixed(1)}% ` +
    `→ $${recommendedAmount.toFixed(2)} on $${bankroll} bankroll. ` +
    `EV: +$${expectedValueUSD.toFixed(2)}.`;

  return {
    kelly_fraction: Number(f_full.toFixed(4)),
    recommended_fraction: Number(f_recommended.toFixed(4)),
    recommended_amount: recommendedAmount,
    net_odds: Number(b.toFixed(4)),
    expected_value: Number(expectedValueUSD.toFixed(2)),
    max_loss: -recommendedAmount,
    reasoning,
    warnings,
    has_edge: true,
  };
}


// ─── Convenience factory using repo Market type ───────────────────────────────

import type { Market } from '../types/market';

/**
 * Size a position directly from a repo Market object.
 * Pulls yesPrice automatically; no need to destructure manually.
 *
 * @example
 *   const sizing = kellySizeFromMarket({
 *     market: matchedMarket,
 *     probability: signal.suggested_action.calibrated_probability ?? 0.6,
 *     direction: signal.suggested_action.direction,
 *     bankroll: 1000,
 *     dataAgeSeconds: metadata.data_age_seconds,
 *   });
 */
export function kellySizeFromMarket(params: {
  market: Market;
  probability: number;
  direction: 'YES' | 'NO';
  bankroll: number;
  kellyFraction?: number;
  maxSingleBetFraction?: number;
  dataAgeSeconds?: number;
}): KellySizing {
  return kellySize({
    probability: params.probability,
    yesPrice: params.market.yesPrice,
    bankroll: params.bankroll,
    direction: params.direction,
    kellyFraction: params.kellyFraction,
    maxSingleBetFraction: params.maxSingleBetFraction,
    dataAgeSeconds: params.dataAgeSeconds,
  });
}
