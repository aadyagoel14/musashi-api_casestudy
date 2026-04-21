/**
 * src/analysis/arbitrage-net.ts
 * ------------------------------
 * Enriches ArbitrageOpportunity with accurate net-profit fields.
 *
 * The existing engine already computes `feesAndSlippage` and `costPerBundle`,
 * but `profitPotential` is still set to the gross spread in several code paths,
 * and there is no `viable` flag or `net_profit_potential` field for bots to act on.
 *
 * This module:
 *   1. Accepts the existing ArbitrageOpportunity type (no schema changes)
 *   2. Computes a rigorous fee breakdown using bid/ask when available, falling
 *      back to midpoint + modeled spread when not
 *   3. Returns an enriched object bots can trust for sizing decisions
 *
 * Fee model (April 2026):
 *   Polymarket  — 2% of winnings on the winning leg
 *   Kalshi      — ~2.8% round-trip (0.7% maker each side + 1.4% settlement)
 *   Slippage    — derived from volume24h as liquidity proxy; +1% thin-book penalty
 *                 below $10k/day. If bid/ask is present, uses half-spread instead.
 */

import type { ArbitrageOpportunity, Market } from '../types/market';

// ─── Extended output type ─────────────────────────────────────────────────────

export interface FeeBreakdown {
  polymarket: number;
  kalshi: number;
  slippage: number;
  total: number;
}

export interface NetArbitrageOpportunity extends ArbitrageOpportunity {
  fees: FeeBreakdown;
  /** Spread minus all fees and estimated slippage (what the bot actually keeps) */
  net_profit_potential: number;
  /** Minimum spread required to break even — useful for logging and UI */
  min_viable_spread: number;
  /** True when net_profit_potential exceeds MIN_VIABLE_NET */
  viable: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum net profit to consider an opportunity worth acting on (0.5%) */
const MIN_VIABLE_NET = 0.005;

/** Polymarket takes 2% of winnings on the winning leg */
const POLY_FEE_RATE = 0.02;

/**
 * Kalshi round-trip:
 *   0.7% maker fee on each side (buy + sell/settle) = 1.4%
 *   ~1.4% settlement fee
 *   ≈ 2.8% total (conservative)
 */
const KALSHI_FEE_ROUND_TRIP = 0.028;

const SLIPPAGE_MULTIPLIER = 0.5;
const MAX_SLIPPAGE = 0.03;
const THIN_BOOK_THRESHOLD = 10_000;
const THIN_BOOK_PENALTY = 0.01;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Estimates slippage for one leg of the trade.
 *
 * Prefers half bid/ask spread when executable quotes are available —
 * that directly measures market impact. Falls back to volume proxy.
 */
export function estimateOneLegSlippage(market: Market, tradeSize: number): number {
  // Use bid/ask half-spread if available (more accurate)
  if (market.yesAsk != null && market.yesBid != null) {
    return (market.yesAsk - market.yesBid) / 2;
  }

  // Volume proxy fallback
  const base = Math.min(
    (tradeSize / Math.max(market.volume24h, 1)) * SLIPPAGE_MULTIPLIER,
    MAX_SLIPPAGE
  );
  const thinBookPenalty = market.volume24h < THIN_BOOK_THRESHOLD ? THIN_BOOK_PENALTY : 0;
  return base + thinBookPenalty;
}

/**
 * Polymarket fee on the winning leg.
 * At yesPrice = 0.60: risk $0.60, win $0.40 net, fee = 2% × $0.40 = $0.008 per dollar notional.
 */
export function polyFeeForPrice(yesPrice: number): number {
  return POLY_FEE_RATE * (1 - yesPrice);
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Enriches a single ArbitrageOpportunity with net-profit fields.
 *
 * Drop-in usage inside api/markets/arbitrage.ts:
 *
 *   import { enrichOpportunity } from '../../src/analysis/arbitrage-net';
 *
 *   const opportunities = rawOpps.map(opp => enrichOpportunity(opp, tradeSize));
 *   const viable = opportunities.filter(o => o.viable);
 *
 * @param opp        Raw opportunity from the existing matching engine
 * @param tradeSize  Intended USD trade size per leg (used for slippage). Default $100.
 */
export function enrichOpportunity(
  opp: ArbitrageOpportunity,
  tradeSize = 100
): NetArbitrageOpportunity {
  // Slippage on each leg separately, then sum
  const slippage_poly = estimateOneLegSlippage(opp.polymarket, tradeSize);
  const slippage_kal  = estimateOneLegSlippage(opp.kalshi, tradeSize);
  const slippage = slippage_poly + slippage_kal;

  // Which platform are we buying YES on? Use ask price when available.
  const buyingYesPrice =
    opp.direction === 'buy_poly_sell_kalshi'
      ? (opp.polymarket.yesAsk ?? opp.polymarket.yesPrice)
      : (opp.kalshi.yesAsk ?? opp.kalshi.yesPrice);

  const fee_poly = polyFeeForPrice(buyingYesPrice);
  const fee_kal  = KALSHI_FEE_ROUND_TRIP;
  const totalFees = fee_poly + fee_kal + slippage;

  // If the engine already computed feesAndSlippage, use whichever is more conservative
  const effectiveFees = opp.feesAndSlippage != null
    ? Math.max(totalFees, opp.feesAndSlippage)
    : totalFees;

  const net = opp.spread - effectiveFees;

  const fees: FeeBreakdown = {
    polymarket:  round4(fee_poly),
    kalshi:      round4(fee_kal),
    slippage:    round4(slippage),
    total:       round4(effectiveFees),
  };

  return {
    ...opp,
    fees,
    net_profit_potential: round4(net),
    min_viable_spread:    round4(effectiveFees),
    viable:               net > MIN_VIABLE_NET,
  };
}

/**
 * Enriches and sorts a list of opportunities by net_profit_potential.
 *
 * @param opportunities  Raw opportunities from the matching engine
 * @param tradeSize      USD per leg for slippage calculation
 * @param viableOnly     Filter out net-negative opportunities
 */
export function enrichArbitrageList(
  opportunities: ArbitrageOpportunity[],
  tradeSize = 100,
  viableOnly = false
): NetArbitrageOpportunity[] {
  const enriched = opportunities.map(opp => enrichOpportunity(opp, tradeSize));
  const filtered = viableOnly ? enriched.filter(o => o.viable) : enriched;
  return filtered.sort((a, b) => b.net_profit_potential - a.net_profit_potential);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
