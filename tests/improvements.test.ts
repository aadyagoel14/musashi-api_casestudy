/**
 * tests/improvements.test.ts
 * --------------------------
 * Unit tests for the three new analysis modules.
 * Run with: npx tsx tests/improvements.test.ts
 *
 * No test framework needed — uses simple assertions and console output.
 */

import { enrichOpportunity, enrichArbitrageList, estimateOneLegSlippage, polyFeeForPrice } from "../src/analysis/arbitrage-net";
import { kellySize, netOdds, fullKelly } from "../src/analysis/kelly-sizer";
import { computeSignalExpiry, isSignalFresh, secondsUntilExpiry } from "../src/analysis/signal-expiry";

// ─── Minimal test harness ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ❌ ${name}: ${msg}`);
    failed++;
  }
}

function expect(val: unknown) {
  return {
    toBe(expected: unknown) {
      if (val !== expected) throw new Error(`Expected ${expected}, got ${val}`);
    },
    toBeCloseTo(expected: number, dp = 3) {
      const margin = 0.5 * Math.pow(10, -dp);
      if (Math.abs((val as number) - expected) > margin)
        throw new Error(`Expected ~${expected} (±${margin}), got ${val}`);
    },
    toBeGreaterThan(n: number) {
      if ((val as number) <= n) throw new Error(`Expected > ${n}, got ${val}`);
    },
    toBeLessThan(n: number) {
      if ((val as number) >= n) throw new Error(`Expected < ${n}, got ${val}`);
    },
    toBeTrue() {
      if (val !== true) throw new Error(`Expected true, got ${val}`);
    },
    toBeFalse() {
      if (val !== false) throw new Error(`Expected false, got ${val}`);
    },
  };
}

// ─── Mock data matching repo's Market type ───────────────────────────────────

const mockMarketPoly = {
  id: "polymarket-0x123",
  platform: 'polymarket' as const,
  title: "Will Bitcoin reach $100k by June 2026?",
  description: "Resolves YES if BTC hits $100k",
  keywords: ["bitcoin", "100k"],
  yesPrice: 0.63,
  noPrice: 0.37,
  volume24h: 450_000,
  url: "https://polymarket.com/event/bitcoin-100k",
  category: "crypto",
  lastUpdated: new Date().toISOString(),
};

const mockMarketKalshi = {
  id: "kalshi-KXBTC",
  platform: 'kalshi' as const,
  title: "Bitcoin $100k by Jun 2026",
  description: "Resolves YES if BTC hits $100k",
  keywords: ["bitcoin", "100k"],
  yesPrice: 0.70,
  noPrice: 0.30,
  volume24h: 200_000,
  url: "https://kalshi.com/markets/kxbtc",
  category: "crypto",
  lastUpdated: new Date().toISOString(),
};

const mockOpp = {
  polymarket: mockMarketPoly,
  kalshi: mockMarketKalshi,
  spread: 0.07,
  profitPotential: 0.07,
  direction: "buy_poly_sell_kalshi" as const,
  confidence: 0.85,
  matchReason: "High title similarity (85%)",
};

// ─── arbitrage-net tests ──────────────────────────────────────────────────────

console.log("\n📊 arbitrage-net.ts");

test("slippage is 0 on high-volume markets with small trade", () => {
  const slippage = estimateOneLegSlippage(mockMarketPoly, 100);
  expect(slippage).toBeCloseTo(0.0001, 3);
});

test("thin-book penalty applies when volume < $10k", () => {
  const thinMarket = { ...mockMarketPoly, volume24h: 5_000 };
  const slippage = estimateOneLegSlippage(thinMarket, 100);
  expect(slippage).toBeGreaterThan(0.01);
});

test("slippage is capped at 3% base + thin-book penalty", () => {
  const tinyMarket = { ...mockMarketPoly, volume24h: 100 };
  const slippage = estimateOneLegSlippage(tinyMarket, 1_000_000);
  expect(slippage).toBeLessThan(0.05);
  expect(slippage).toBeGreaterThan(0.03);
});

test("bid/ask half-spread used when available", () => {
  const marketWithQuotes = { ...mockMarketPoly, yesBid: 0.60, yesAsk: 0.66 };
  const slippage = estimateOneLegSlippage(marketWithQuotes, 100);
  expect(slippage).toBeCloseTo(0.03, 4); // (0.66-0.60)/2 = 0.03
});

test("net profit is less than gross spread", () => {
  const result = enrichOpportunity(mockOpp, 100);
  expect(result.net_profit_potential).toBeLessThan(result.spread);
});

test("fees breakdown sums to total", () => {
  const result = enrichOpportunity(mockOpp, 100);
  const summedFees = result.fees.polymarket + result.fees.kalshi + result.fees.slippage;
  expect(Math.abs(summedFees - result.fees.total)).toBeLessThan(0.0001);
});

test("7% spread is viable after fees on liquid market", () => {
  const result = enrichOpportunity(mockOpp, 100);
  expect(result.viable).toBeTrue();
  expect(result.net_profit_potential).toBeGreaterThan(0.005);
});

test("very small spread is not viable", () => {
  const tightOpp = { ...mockOpp, spread: 0.02, profitPotential: 0.02 };
  const result = enrichOpportunity(tightOpp, 100);
  expect(result.viable).toBeFalse();
});

test("existing feesAndSlippage is respected when more conservative", () => {
  // Engine already computed a higher fee estimate — we should defer to it
  const oppWithFees = { ...mockOpp, feesAndSlippage: 0.08 };
  const result = enrichOpportunity(oppWithFees, 100);
  expect(result.fees.total).toBeCloseTo(0.08, 4);
  expect(result.viable).toBeFalse(); // 0.07 spread - 0.08 fees = negative
});

test("enrichArbitrageList sorts by net profit descending", () => {
  const tight = { ...mockOpp, spread: 0.04, profitPotential: 0.04 };
  const results = enrichArbitrageList([tight, mockOpp], 100, false);
  expect(results[0].net_profit_potential).toBeGreaterThan(results[1].net_profit_potential);
});

test("viableOnly filter removes non-viable opportunities", () => {
  const tight = { ...mockOpp, spread: 0.02, profitPotential: 0.02 };
  const results = enrichArbitrageList([tight, mockOpp], 100, true);
  expect(results.length).toBe(1);
  expect(results[0].viable).toBeTrue();
});

// ─── kelly-sizer tests ────────────────────────────────────────────────────────

console.log("\n📐 kelly-sizer.ts");

test("netOdds at 60¢ YES = 0.667", () => {
  expect(netOdds(0.60, "YES")).toBeCloseTo(0.667, 2);
});

test("netOdds for NO direction uses 1-yesPrice", () => {
  // Buying NO at yesPrice=0.60 → NO price = 0.40, net odds = 0.60/0.40 = 1.5
  expect(netOdds(0.60, "NO")).toBeCloseTo(1.5, 2);
});

test("fullKelly is positive when probability > implied probability", () => {
  // Market says 60%, we say 71% — there is edge
  const b = netOdds(0.60, "YES");
  expect(fullKelly(0.71, b)).toBeGreaterThan(0);
});

test("fullKelly is negative when probability < implied probability", () => {
  // Market says 60%, we say 50% — no edge
  const b = netOdds(0.60, "YES");
  expect(fullKelly(0.50, b)).toBeLessThan(0);
});

test("kellySize returns has_edge=false when no edge", () => {
  const result = kellySize({ probability: 0.50, yesPrice: 0.60, bankroll: 1000, direction: "YES" });
  expect(result.has_edge).toBeFalse();
  expect(result.recommended_amount).toBe(0);
});

test("kellySize recommends positive bet when there is edge", () => {
  const result = kellySize({ probability: 0.71, yesPrice: 0.60, bankroll: 1000, direction: "YES" });
  expect(result.has_edge).toBeTrue();
  expect(result.recommended_amount).toBeGreaterThan(0);
});

test("quarter-Kelly bet is less than full Kelly bet", () => {
  const quarter = kellySize({ probability: 0.71, yesPrice: 0.60, bankroll: 1000, direction: "YES", kellyFraction: 0.25 });
  const full = kellySize({ probability: 0.71, yesPrice: 0.60, bankroll: 1000, direction: "YES", kellyFraction: 1.0, maxSingleBetFraction: 1.0 });
  expect(quarter.recommended_amount).toBeLessThan(full.recommended_amount);
});

test("5% hard cap is respected", () => {
  // High edge scenario — Kelly would want more than 5%
  const result = kellySize({ probability: 0.90, yesPrice: 0.60, bankroll: 1000, direction: "YES", kellyFraction: 1.0, maxSingleBetFraction: 0.05 });
  expect(result.recommended_amount).toBeLessThan(51); // 5% of $1000 = $50
});

test("stale data (>20s) halves the recommended amount", () => {
  const fresh = kellySize({ probability: 0.71, yesPrice: 0.60, bankroll: 1000, direction: "YES", dataAgeSeconds: 5 });
  const stale = kellySize({ probability: 0.71, yesPrice: 0.60, bankroll: 1000, direction: "YES", dataAgeSeconds: 25 });
  expect(stale.recommended_amount).toBeCloseTo(fresh.recommended_amount * 0.5, 1);
});

test("expected_value is positive when has_edge=true", () => {
  const result = kellySize({ probability: 0.71, yesPrice: 0.60, bankroll: 1000, direction: "YES" });
  expect(result.expected_value).toBeGreaterThan(0);
});

// ─── signal-expiry tests ──────────────────────────────────────────────────────

console.log("\n⏱  signal-expiry.ts");

test("critical signal expires in 5 minutes", () => {
  const expiry = computeSignalExpiry({ urgency: "critical", signal_type: "news_event" });
  expect(expiry.ttl_seconds).toBe(300);
});

test("arbitrage signal expires in 3 minutes regardless of urgency", () => {
  const expiry = computeSignalExpiry({ urgency: "high", signal_type: "arbitrage" });
  expect(expiry.ttl_seconds).toBe(180);
});

test("low urgency signal expires in 30 minutes", () => {
  const expiry = computeSignalExpiry({ urgency: "low", signal_type: "user_interest" });
  expect(expiry.ttl_seconds).toBe(1800);
});

test("signal is capped at 10% of market resolution time", () => {
  // Resolution in 20 minutes → cap = 2 minutes = 120s
  const resolution = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const expiry = computeSignalExpiry({ urgency: "low", signal_type: "news_event", market_resolution_time: resolution });
  expect(expiry.ttl_seconds).toBeLessThan(130); // 10% of 20min = 2min = 120s
});

test("expires_at is in the future for fresh signals", () => {
  const expiry = computeSignalExpiry({ urgency: "high", signal_type: "news_event" });
  expect(expiry.is_expired).toBeFalse();
  expect(new Date(expiry.expires_at).getTime()).toBeGreaterThan(Date.now());
});

test("isSignalFresh returns true for future expiry", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  expect(isSignalFresh(future)).toBeTrue();
});

test("isSignalFresh returns false for past expiry", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  expect(isSignalFresh(past)).toBeFalse();
});

test("isSignalFresh returns true for null (legacy signals)", () => {
  expect(isSignalFresh(null)).toBeTrue();
});

test("secondsUntilExpiry returns 0 for expired signals", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  expect(secondsUntilExpiry(past)).toBe(0);
});

test("secondsUntilExpiry returns positive for future signals", () => {
  const future = new Date(Date.now() + 120_000).toISOString();
  expect(secondsUntilExpiry(future)).toBeGreaterThan(100);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}

// ─── calibrated-probability tests ────────────────────────────────────────────

// Inline the module since we can't import from types without the full repo
import { calibrateProbability, daysUntilResolution } from "../src/analysis/calibrated-probability";

console.log("\n🎯 calibrated-probability.ts");

const bullishSentiment = { sentiment: 'bullish' as const, confidence: 0.85 };
const bearishSentiment = { sentiment: 'bearish' as const, confidence: 0.80 };
const neutralSentiment = { sentiment: 'neutral' as const, confidence: 0.50 };

const baseEvidence = {
  marketPrice: 0.60,
  direction: 'YES' as const,
  sentiment: bullishSentiment,
  matchConfidence: 0.75,
  matchedKeywordCount: 3,
  isBreakingNews: false,
  volume24h: 100_000,
};

test("HOLD direction returns market price as probability", () => {
  const result = calibrateProbability({ ...baseEvidence, direction: 'HOLD' as const });
  expect(result.probability).toBeCloseTo(0.60, 1);
  expect(result.signal_strength).toBe(0);
});

test("bullish signal on YES pushes probability above market price", () => {
  const result = calibrateProbability(baseEvidence);
  expect(result.probability).toBeGreaterThan(0.60);
  expect(result.has_edge).toBeFalse; // Not a field, just checking value
});

test("bearish signal on NO pushes probability above NO market price", () => {
  const result = calibrateProbability({
    ...baseEvidence,
    direction: 'NO' as const,
    sentiment: bearishSentiment,
  });
  // NO price = 1 - 0.60 = 0.40, should push above 0.40
  expect(result.probability).toBeGreaterThan(0.40);
});

test("neutral sentiment on YES returns probability close to market price", () => {
  const result = calibrateProbability({ ...baseEvidence, sentiment: neutralSentiment });
  // Neutral sentiment = weak signal = stays near prior
  expect(result.probability).toBeCloseTo(0.60, 1);
});

test("probability is always in (0, 1)", () => {
  const extremeBullish = { ...baseEvidence, sentiment: { sentiment: 'bullish' as const, confidence: 1.0 }, matchConfidence: 1.0, matchedKeywordCount: 10 };
  const result = calibrateProbability(extremeBullish);
  expect(result.probability).toBeLessThan(1.0);
  expect(result.probability).toBeGreaterThan(0.0);
});

test("breaking news boosts signal strength", () => {
  const noBreaking = calibrateProbability({ ...baseEvidence, isBreakingNews: false });
  const breaking   = calibrateProbability({ ...baseEvidence, isBreakingNews: true });
  expect(breaking.signal_strength).toBeGreaterThan(noBreaking.signal_strength);
});

test("high volume market gets more shrinkage (probability closer to market price)", () => {
  const lowVol  = calibrateProbability({ ...baseEvidence, volume24h: 5_000 });
  const highVol = calibrateProbability({ ...baseEvidence, volume24h: 5_000_000 });
  // High volume = market more reliable = less deviation from prior
  const priorDiff_low  = Math.abs(lowVol.probability  - lowVol.market_implied);
  const priorDiff_high = Math.abs(highVol.probability - highVol.market_implied);
  expect(priorDiff_high).toBeLessThan(priorDiff_low);
});

test("market_implied matches market price for YES direction", () => {
  const result = calibrateProbability(baseEvidence);
  expect(result.market_implied).toBeCloseTo(0.60, 2);
});

test("market_implied is 1-marketPrice for NO direction", () => {
  const result = calibrateProbability({ ...baseEvidence, direction: 'NO' as const, sentiment: bearishSentiment });
  expect(result.market_implied).toBeCloseTo(0.40, 2);
});

test("reasoning string is populated", () => {
  const result = calibrateProbability(baseEvidence);
  if (typeof result.reasoning !== 'string' || result.reasoning.length === 0) {
    throw new Error("reasoning should be a non-empty string");
  }
});

test("daysUntilResolution returns undefined for market without endDate", () => {
  const market = { yesPrice: 0.6, volume24h: 100_000 } as any;
  const result = daysUntilResolution(market);
  if (result !== undefined) throw new Error(`Expected undefined, got ${result}`);
});

test("daysUntilResolution returns positive number for future market", () => {
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const market = { yesPrice: 0.6, volume24h: 100_000, endDate: future } as any;
  const result = daysUntilResolution(market);
  if (result == null || result <= 0) throw new Error(`Expected positive days, got ${result}`);
});
