/**
 * api/size-position.ts
 * --------------------
 * POST /api/size-position
 *
 * Returns Kelly-optimal position sizing for a given signal and bankroll.
 * Designed to be called immediately after /api/analyze-text or /api/markets/arbitrage.
 *
 * Request body:
 * {
 *   "market_id":    "polymarket-0x123...",   // required
 *   "direction":    "YES" | "NO",            // required
 *   "yes_price":    0.62,                    // required — current market price
 *   "probability":  0.71,                    // required — your calibrated estimate
 *   "bankroll":     1000,                    // required — current balance in USD
 *   "kelly_fraction": 0.25,                  // optional (default: 0.25 = quarter-Kelly)
 *   "max_bet_fraction": 0.05,               // optional (default: 0.05 = 5% of bankroll)
 *   "data_age_seconds": 12                  // optional — from API metadata, triggers stale penalty
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "kelly_fraction": 0.087,
 *     "recommended_fraction": 0.022,
 *     "recommended_amount": 21.80,
 *     "net_odds": 0.613,
 *     "expected_value": 4.12,
 *     "max_loss": -21.80,
 *     "has_edge": true,
 *     "reasoning": "p=71%, b=0.613 → full Kelly f*=8.7%, quarter-Kelly=2.2% → $21.80...",
 *     "warnings": [],
 *     "limits": {
 *       "kelly_fraction_used": 0.25,
 *       "max_single_bet_fraction": 0.05,
 *       "stale_data_penalty_applied": false
 *     }
 *   }
 * }
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { kellySize } from "../../src/analysis/kelly-sizer";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed. Use POST.",
    });
  }

  const body = req.body;

  // ── Validate required fields ───────────────────────────────────────────────
  const { market_id, direction, yes_price, probability, bankroll } = body ?? {};

  if (!market_id || typeof market_id !== "string") {
    return res.status(400).json({ success: false, error: "market_id is required (string)" });
  }
  if (direction !== "YES" && direction !== "NO") {
    return res.status(400).json({ success: false, error: 'direction must be "YES" or "NO"' });
  }
  if (typeof yes_price !== "number" || yes_price <= 0 || yes_price >= 1) {
    return res.status(400).json({ success: false, error: "yes_price must be a number in (0, 1)" });
  }
  if (typeof probability !== "number" || probability < 0 || probability > 1) {
    return res.status(400).json({ success: false, error: "probability must be a number in [0, 1]" });
  }
  if (typeof bankroll !== "number" || bankroll <= 0) {
    return res.status(400).json({ success: false, error: "bankroll must be a positive number" });
  }

  // ── Optional parameters ────────────────────────────────────────────────────
  const kelly_fraction =
    typeof body.kelly_fraction === "number" && body.kelly_fraction > 0 && body.kelly_fraction <= 1
      ? body.kelly_fraction
      : 0.25;

  const max_bet_fraction =
    typeof body.max_bet_fraction === "number" && body.max_bet_fraction > 0 && body.max_bet_fraction <= 1
      ? body.max_bet_fraction
      : 0.05;

  const data_age_seconds =
    typeof body.data_age_seconds === "number" && body.data_age_seconds >= 0
      ? body.data_age_seconds
      : 0;

  // ── Compute sizing ─────────────────────────────────────────────────────────
  try {
    const sizing = kellySize({
      probability,
      yesPrice: yes_price,
      bankroll,
      direction,
      kellyFraction: kelly_fraction,
      maxSingleBetFraction: max_bet_fraction,
      dataAgeSeconds: data_age_seconds,
    });

    return res.status(200).json({
      success: true,
      data: {
        market_id,
        direction,
        ...sizing,
        limits: {
          kelly_fraction_used: kelly_fraction,
          max_single_bet_fraction: max_bet_fraction,
          stale_data_penalty_applied: data_age_seconds > 20,
        },
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(400).json({ success: false, error: message });
  }
}
