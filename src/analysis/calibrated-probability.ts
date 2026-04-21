/**
 * src/analysis/calibrated-probability.ts
 * ----------------------------------------
 * Replaces the raw edge score with a calibrated win probability estimate.
 *
 * The current signal-generator computes:
 *   edge = sentiment.confidence × |impliedProb − marketPrice|
 *   actionConfidence = edge × 1.2 (urgency multiplier)
 *
 * This is not a probability — it's an unbounded heuristic. A bot that
 * interprets confidence: 0.85 as "85% chance of winning" will systematically
 * missize positions.
 *
 * This module produces a true probability p ∈ (0, 1) that is:
 *   - Anchored to the market price as the prior (market is usually right)
 *   - Updated by signal strength (sentiment × match quality × engagement)
 *   - Compressed toward 0.5 when evidence is weak (uncertainty penalty)
 *   - Interpretable: p = 0.71 means "we estimate 71% chance YES wins"
 *
 * Design: Bayesian-style update on a Beta distribution prior.
 *   prior     = market price (market's implied probability)
 *   likelihood = signal strength derived from all available evidence
 *   posterior  = weighted blend, shrunk toward 0.5 by uncertainty
 *
 * This is intentionally transparent and auditable — no black-box ML.
 * It can be replaced with a trained logistic regression head once
 * labeled outcome data is collected via signal_outcomes tracking.
 */

import type { Market } from '../types/market';
import type { SentimentResult } from './sentiment-analyzer';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SignalEvidence {
  /** Market's current YES price (the prior) */
  marketPrice: number;
  /** Direction the signal is recommending */
  direction: 'YES' | 'NO' | 'HOLD';
  /** Sentiment result from analyzeSentiment() */
  sentiment: SentimentResult;
  /** Keyword match confidence from KeywordMatcher (0-1) */
  matchConfidence: number;
  /** Number of keywords matched */
  matchedKeywordCount: number;
  /** Whether the tweet contains breaking news markers */
  isBreakingNews: boolean;
  /** Market 24h volume — higher = more liquid = market price more reliable */
  volume24h: number;
  /** Days until market resolves — shorter = signal more time-sensitive */
  daysToResolution?: number;
  /**
   * Optional: tweet engagement signal (likes + retweets).
   * Higher engagement = more likely to move markets.
   * Pass 0 if not available (degrades gracefully).
   */
  tweetEngagement?: number;
}

export interface CalibratedProbability {
  /** Calibrated win probability for the suggested direction (0-1) */
  probability: number;
  /** The market's implied probability (prior) */
  market_implied: number;
  /** Raw signal strength before calibration (0-1) */
  signal_strength: number;
  /** Uncertainty penalty applied (0-1, higher = more shrinkage toward 0.5) */
  uncertainty: number;
  /** Human-readable explanation */
  reasoning: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Shrinkage weight toward 0.5 (the maximum entropy prior).
 * Higher = more conservative, more shrinkage when evidence is weak.
 * 0.35 means: even a strong signal can only move the prior ~65% of the way.
 */
const SHRINKAGE = 0.35;

/**
 * Minimum signal strength required to deviate from the prior.
 * Below this, we return the market price as our best estimate.
 */
const MIN_SIGNAL_STRENGTH = 0.10;

/**
 * Volume threshold above which the market price is considered highly reliable.
 * High-volume markets are harder to beat — apply extra shrinkage.
 */
const HIGH_VOLUME_THRESHOLD = 1_000_000;

// ─── Signal strength components ───────────────────────────────────────────────

/**
 * Converts sentiment into a directional push.
 * Returns signed value: positive = push toward YES, negative = push toward NO.
 * Magnitude = how hard we're pushing.
 */
function sentimentSignal(sentiment: SentimentResult, direction: 'YES' | 'NO' | 'HOLD'): number {
  if (direction === 'HOLD' || sentiment.sentiment === 'neutral') return 0;

  const push = sentiment.confidence; // 0-1, how strong the sentiment is

  if (sentiment.sentiment === 'bullish') {
    return direction === 'YES' ? push : -push;
  }
  // bearish
  return direction === 'NO' ? push : -push;
}

/**
 * Match quality component: higher keyword match confidence = more reliable signal.
 * Uses sqrt compression so confidence: 0.8 → 0.89, not 0.8 (avoids overconfidence).
 */
function matchQualitySignal(matchConfidence: number, keywordCount: number): number {
  const base = Math.sqrt(Math.min(matchConfidence, 1));
  // Bonus for matching multiple distinct keywords (more specific signal)
  const coverageBonus = Math.min(0.15, (keywordCount - 1) * 0.05);
  return Math.min(1, base + coverageBonus);
}

/**
 * Breaking news multiplier: fresh news moves markets faster.
 */
function breakingNewsMultiplier(isBreaking: boolean): number {
  return isBreaking ? 1.25 : 1.0;
}

/**
 * Engagement weight: viral tweets are more likely to move markets.
 * log-scaled to prevent massive engagement from dominating.
 * Returns 1.0 (no adjustment) when engagement data unavailable.
 */
function engagementWeight(engagement: number): number {
  if (engagement <= 0) return 1.0;
  // log(1 + engagement) / log(1 + 10000) → 0 to 1 range
  // At 100 engagement: ~0.5; at 10k: ~1.0; at 1M: ~1.5 (capped at 1.5)
  return Math.min(1.5, 1.0 + Math.log1p(engagement) / Math.log1p(10_000));
}

/**
 * Market reliability penalty: liquid markets are harder to beat.
 * High-volume markets = market price is more informative = more shrinkage.
 */
function marketReliabilityPenalty(volume24h: number): number {
  if (volume24h >= HIGH_VOLUME_THRESHOLD) return 0.75; // Apply 25% extra shrinkage
  if (volume24h >= 100_000) return 0.90;
  return 1.0; // Thin markets — our signal is relatively more informative
}

/**
 * Time pressure bonus: signals on markets expiring soon are more actionable.
 * A signal 1 day before resolution has less time for mean-reversion.
 */
function timePressureBonus(daysToResolution?: number): number {
  if (daysToResolution == null) return 0;
  if (daysToResolution <= 1)  return 0.10;
  if (daysToResolution <= 7)  return 0.05;
  return 0;
}

// ─── Core calibration ─────────────────────────────────────────────────────────

/**
 * Computes a calibrated win probability from all available signal evidence.
 *
 * Usage in signal-generator.ts:
 *
 *   import { calibrateProbability } from './calibrated-probability';
 *
 *   const cal = calibrateProbability({
 *     marketPrice: topMarket.yesPrice,
 *     direction: suggested_action.direction,
 *     sentiment,
 *     matchConfidence: topMatch.confidence,
 *     matchedKeywordCount: topMatch.matchedKeywords.length,
 *     isBreakingNews: isBreakingNews(tweetText),
 *     volume24h: topMarket.volume24h,
 *     daysToResolution: daysUntil(topMarket.endDate),
 *   });
 *
 *   // Add to suggested_action:
 *   suggested_action.calibrated_probability = cal.probability;
 */
export function calibrateProbability(evidence: SignalEvidence): CalibratedProbability {
  const {
    marketPrice,
    direction,
    sentiment,
    matchConfidence,
    matchedKeywordCount,
    isBreakingNews,
    volume24h,
    daysToResolution,
    tweetEngagement = 0,
  } = evidence;

  // Prior: the market is our best starting estimate
  const prior = direction === 'NO' ? (1 - marketPrice) : marketPrice;

  // No signal on HOLD
  if (direction === 'HOLD') {
    return {
      probability: prior,
      market_implied: prior,
      signal_strength: 0,
      uncertainty: 1,
      reasoning: 'HOLD signal — returning market implied probability as estimate.',
    };
  }

  // ── Build signal strength from components ─────────────────────────────────

  const sentimentPush   = Math.abs(sentimentSignal(sentiment, direction));
  const matchQuality    = matchQualitySignal(matchConfidence, matchedKeywordCount);
  const newsMultiplier  = breakingNewsMultiplier(isBreakingNews);
  const engWeight       = engagementWeight(tweetEngagement);
  const mktPenalty      = marketReliabilityPenalty(volume24h);
  const timePressure    = timePressureBonus(daysToResolution);

  // Signal strength: product of components, bounded to [0, 1]
  const rawStrength = sentimentPush * matchQuality * newsMultiplier * engWeight * mktPenalty;
  const signalStrength = Math.min(1, rawStrength + timePressure);

  // Weak signal — don't deviate from the prior
  if (signalStrength < MIN_SIGNAL_STRENGTH) {
    return {
      probability: round2(prior),
      market_implied: round2(prior),
      signal_strength: round2(signalStrength),
      uncertainty: 1,
      reasoning: `Weak signal (strength=${signalStrength.toFixed(2)}) — deferring to market implied probability of ${(prior * 100).toFixed(0)}%.`,
    };
  }

  // ── Bayesian-style update ─────────────────────────────────────────────────
  // Posterior = prior + signal_strength × (1 − prior) adjusted by shrinkage
  // Shrinkage pulls toward 0.5 when evidence is uncertain.

  const uncertainty = Math.max(0, 1 - signalStrength);
  const shrinkToward = 0.5;
  const shrinkageAmount = SHRINKAGE * uncertainty;

  // Update: move prior toward 1.0 (strong YES signal) or toward 0.0 (strong NO)
  const update = signalStrength * (1 - prior); // how much room to move
  const rawPosterior = prior + update * (1 - SHRINKAGE);

  // Apply shrinkage toward 0.5
  const posterior = rawPosterior * (1 - shrinkageAmount) + shrinkToward * shrinkageAmount;

  // Clamp to valid probability range
  const probability = Math.min(0.97, Math.max(0.03, posterior));

  const reasoning =
    `Prior: market=${(prior * 100).toFixed(0)}% | ` +
    `Sentiment: ${sentiment.sentiment} (${(sentiment.confidence * 100).toFixed(0)}%) | ` +
    `Match quality: ${(matchQuality * 100).toFixed(0)}% | ` +
    `Signal strength: ${(signalStrength * 100).toFixed(0)}% | ` +
    `Calibrated: ${(probability * 100).toFixed(0)}%` +
    (isBreakingNews ? ' [breaking news boost]' : '') +
    (tweetEngagement > 100 ? ` [engagement ×${engWeight.toFixed(2)}]` : '');

  return {
    probability: round2(probability),
    market_implied: round2(prior),
    signal_strength: round2(signalStrength),
    uncertainty: round2(uncertainty),
    reasoning,
  };
}

/**
 * Helper: days until a market resolves.
 * Returns undefined if no endDate available.
 */
export function daysUntilResolution(market: Market): number | undefined {
  if (!market.endDate) return undefined;
  const ms = new Date(market.endDate).getTime() - Date.now();
  if (ms <= 0) return 0;
  return ms / (1000 * 60 * 60 * 24);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
