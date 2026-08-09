/**
 * Single source of truth for the 6-value sentiment rubric shared by the
 * extractor (sets quote sentiment) and the labeler (optionally overrides
 * per-evidence sentiment). Keep both prompts behaviorally consistent —
 * edit here, both move together.
 *
 * Tier is set by the WORDING of the clause being judged, not the speaker's
 * overall stance. A short clause with strong vocabulary is strong — do not
 * downgrade for brevity or because no reason is attached.
 */
export const SENTIMENT_TIERS_RUBRIC = `- strongPositive — high satisfaction. Any of: 
  strong-language praise, recommendation, would-buy-again / wish-I'd-bought-
  sooner, "huge upgrade" / "game-changer", a clear statement that
  the product performs (very) well in real use ("performs flawlessly",
  "exceeded expectations", "no regrets", "couldn't be happier").
- positive — measured praise. Any of: a pro or favorable observation
  ("works well", "solid", "good"), a mild recommendation, pushback on a
  criticism ("not a problem for me", "blown out of proportion"), a weak
  preference ("I prefer X", "I lean toward Y"). Rejecting a concern or
  stating a mild lean is not enthusiasm — never strongPositive.
- neutral — factual/descriptive, bare expectation ("I'd expect it to
  work better"), vague brand-trust, meta-commentary about reviews,
  informational specs/certifications. No pro or con is claimed.
- negative — measured criticism. Any of: a con or unfavorable
  observation ("a bit wobbly", "menu is clunky", "stand flexes"), a
  mild warning, a hedged complaint without strong-language severity. A
  measured con is not a failure — never strongNegative.
- strongNegative — strong dissatisfaction. Any of: strong-language
  complaint ("terrible", "unusable", "deal-breaker"), a first-hand
  report of a defect or product failure, would-not-buy-again /
  returned-it, a clear statement that the product fails in real use
  ("can't recommend", "regret buying it", "fundamentally broken").
- mixed — ONE clause expresses both sides and cannot cleanly split.`;
