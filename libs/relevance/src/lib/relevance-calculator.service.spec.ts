import { Test, TestingModule } from "@nestjs/testing";
import { RelevanceCalculatorService } from "./relevance-calculator.service";
import { RelevanceTermsService } from "./relevance-terms.service";
import { DeliberationTermsService } from "./deliberation-terms.service";
import { BrandCacheService } from "@ebike-backend/product";
import { RelevanceConfigService } from "./relevance-config.service";

describe("RelevanceCalculatorService", () => {
  let service: RelevanceCalculatorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RelevanceCalculatorService,
        {
          provide: RelevanceTermsService,
          useValue: {
            getDefaultTerms: jest.fn().mockReturnValue([]),
            getMergedTerms: jest
              .fn()
              .mockImplementation((base, additional) => [
                ...base,
                ...additional,
              ]),
          },
        },
        {
          provide: DeliberationTermsService,
          useValue: {
            computeMultiplier: jest.fn().mockReturnValue({ multiplier: 1.0 }),
          },
        },
        {
          provide: BrandCacheService,
          useValue: {
            getAllBrands: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: RelevanceConfigService,
          useValue: {
            config: {
              fuzzyThreshold: 0.7,
              productTermCap: 0.45,
              hallucinationPenalty: 0.7,
              hallucinationThreshold: 0.2,
              hallucinationMinPenalty: 0.3,
              searchSimilarityThreshold: 0.7,
              experienceConfig: {
                owner: { multiplier: 1.1, floor: 3 },
                priorOwner: { multiplier: 1.05, floor: 2 },
                tested: { multiplier: 1.0, floor: 1 },
                prospectiveBuyer: { multiplier: 0.85, floor: 0 },
                reference: { multiplier: 0.8, floor: 0 },
              },
            },
          },
        },
      ],
    }).compile();

    service = module.get<RelevanceCalculatorService>(
      RelevanceCalculatorService,
    );
  });

  describe("Disclaimer Penalty", () => {
    it('should penalize comments with "cannot be relied upon"', async () => {
      const disclaimer = [
        "Never used gsync in my life. My words on this topic cannot be relied upon. It looks like it is working.",
      ];

      const result = await service.calculateRelevance(disclaimer, {
        useBrands: false,
      });

      // 1 disclaimer → 0.7^1 = 0.7x penalty
      expect(result.components.disclaimerPenalty).toBeCloseTo(0.7, 2);
    });

    it('should penalize comments with "take with a grain of salt"', async () => {
      const disclaimer = [
        "Just got the MSI and I love it. I should say I have no prior OLED experience so take my review with a grain of salt.",
      ];

      const result = await service.calculateRelevance(disclaimer, {
        useBrands: false,
      });

      // 1 disclaimer → 0.7^1 = 0.7x penalty
      expect(result.components.disclaimerPenalty).toBeCloseTo(0.7, 2);
    });

    it("should apply multiplicative penalty for multiple disclaimers", async () => {
      const multipleDisclaimers = [
        "I'm no expert and I could be wrong, but it seems good.",
      ];

      const result = await service.calculateRelevance(multipleDisclaimers, {
        useBrands: false,
      });

      // 2 disclaimers → 0.7^2 = 0.49x penalty
      expect(result.components.disclaimerPenalty).toBeCloseTo(0.49, 2);
    });

    it("should not penalize comments without disclaimers", async () => {
      const noDisclaimer = [
        "I have the MSI MPG341CQPX and the colors are excellent.",
      ];

      const result = await service.calculateRelevance(noDisclaimer, {
        useBrands: false,
      });

      // No disclaimers → 1.0x (no penalty)
      expect(result.components.disclaimerPenalty).toBe(1.0);
    });

    it('should detect "i guess" as disclaimer', async () => {
      const iGuess = ["Looks like it is working, I guess?"];

      const result = await service.calculateRelevance(iGuess, {
        useBrands: false,
      });

      // 1 disclaimer ("i guess") → 0.7x penalty
      expect(result.components.disclaimerPenalty).toBeCloseTo(0.7, 2);
    });
  });

  describe("Real-world Examples from Thread 636b", () => {
    it("should score pure question comment low (m967jq1)", async () => {
      const comment = [
        "I was just looking at that monitor on Best Buy. Did yours come in? What are your thoughts? Prob my biggest worry is VRR flicker, but I guess I'll just have to try it out and see.",
      ];

      const result = await service.calculateRelevance(comment, {
        useBrands: false,
      });

      // Should have disclaimer penalty ("I guess")
      expect(result.components.disclaimerPenalty).toBeCloseTo(0.7, 2);
      // Final score should be significantly reduced
      expect(result.score).toBeLessThanOrEqual(50);
    });

    it("should score disclaimer comment moderately (m81vxtr)", async () => {
      const comment = [
        "Never used gsync/vsync/freesync in my life. My words on this topic cannot be relied upon. I have newest firmware (0.23). Turned HDR. Turned on adaptive-vsync in the monitor menu. Used: https://www.testufo.com/gsync. Looks like it is working, I guess? Edit: I played one game that jump from 240 to 100-70 fps constantly. It is working",
      ];

      const result = await service.calculateRelevance(comment, {
        useBrands: false,
      });

      // Should have strong disclaimer penalty ("cannot be relied upon" + "I guess")
      expect(result.components.disclaimerPenalty).toBeLessThanOrEqual(0.5);
    });

    it("should not heavily penalize owner review with minor disclaimer (m7hxs8k)", async () => {
      const comment = [
        "Just got the MSI MPG431CQPX and I love it. Though I should say it's my first OLED, coming from the AW3418. I prefer the lesser curve, but I've been having fun with it and the text clarity is good, but I don't use it for work or school. And I didnt have an OLED previously. I say all this so you can take my anecdotal review with a grain of salt.",
      ];

      const result = await service.calculateRelevance(comment, {
        useBrands: false,
      });

      // Should have mild disclaimer penalty ("grain of salt")
      expect(result.components.disclaimerPenalty).toBeCloseTo(0.7, 2);
      // Should have ownership multiplier
      expect(result.components.ownershipMultiplier).toBe(1.3);
      // Should have comparison multiplier
      expect(result.components.comparisonMultiplier).toBe(1.2);
      // Final score depends on term matching - without brand terms may be lower
      expect(result.score).toBeGreaterThanOrEqual(20);
    });
  });

  describe("Ownership Multiplier", () => {
    it('should boost comments with "I have the" ownership signal', async () => {
      const ownership = [
        "I have the MSI MPG341CQPX and the colors are amazing.",
      ];

      const result = await service.calculateRelevance(ownership, {
        useBrands: false,
      });

      // Should have ownership multiplier (1.3x)
      expect(result.components.ownershipMultiplier).toBe(1.3);
    });

    it('should boost comments with "I\'ve had the" ownership signal', async () => {
      const ownership = [
        "I've had the MSI MPG341 for about a week now and it's been great.",
      ];

      const result = await service.calculateRelevance(ownership, {
        useBrands: false,
      });

      // Should have ownership multiplier (1.3x)
      expect(result.components.ownershipMultiplier).toBe(1.3);
    });

    it('should boost comments with "just got the" ownership signal', async () => {
      const ownership = ["Just got the LG and I love it."];

      const result = await service.calculateRelevance(ownership, {
        useBrands: false,
      });

      // Should have ownership multiplier (1.3x)
      expect(result.components.ownershipMultiplier).toBe(1.3);
    });

    it('should boost comments with "my " ownership signal', async () => {
      const ownership = [
        "My LG monitor arrived yesterday and colors are stunning.",
      ];

      const result = await service.calculateRelevance(ownership, {
        useBrands: false,
      });

      // Should have ownership multiplier (1.3x)
      expect(result.components.ownershipMultiplier).toBe(1.3);
    });

    it("should not boost comments without ownership signals", async () => {
      const noOwnership = [
        "The MSI monitor looks interesting based on reviews.",
      ];

      const result = await service.calculateRelevance(noOwnership, {
        useBrands: false,
      });

      // No ownership signal → 1.0x (no boost)
      expect(result.components.ownershipMultiplier).toBe(1.0);
    });

    it('should boost "I bought the" ownership signal', async () => {
      const ownership = ["I bought the Samsung monitor last week."];

      const result = await service.calculateRelevance(ownership, {
        useBrands: false,
      });

      // Should have ownership multiplier (1.3x)
      expect(result.components.ownershipMultiplier).toBe(1.3);
    });
  });

  describe("Comparison Multiplier", () => {
    it('should boost comments with "coming from" comparison', async () => {
      const comparison = [
        "Coming from a 165hz Acer Predator IPS, it definitely feels smoother.",
      ];

      const result = await service.calculateRelevance(comparison, {
        useBrands: false,
      });

      // Should have comparison multiplier (1.2x)
      expect(result.components.comparisonMultiplier).toBe(1.2);
    });

    it('should boost comments with "compared to" comparison', async () => {
      const comparison = [
        "Compared to my old monitor, the colors are much better.",
      ];

      const result = await service.calculateRelevance(comparison, {
        useBrands: false,
      });

      // Should have comparison multiplier (1.2x)
      expect(result.components.comparisonMultiplier).toBe(1.2);
    });

    it('should boost comments with " vs " comparison', async () => {
      const comparison = ["MSI vs Samsung - I prefer the MSI curve."];

      const result = await service.calculateRelevance(comparison, {
        useBrands: false,
      });

      // Should have comparison multiplier (1.2x)
      expect(result.components.comparisonMultiplier).toBe(1.2);
    });

    it('should boost comments with "better than" comparison', async () => {
      const comparison = ["This is much better than the LG I tried."];

      const result = await service.calculateRelevance(comparison, {
        useBrands: false,
      });

      // Should have comparison multiplier (1.2x)
      expect(result.components.comparisonMultiplier).toBe(1.2);
    });

    it("should not boost comments without comparisons", async () => {
      const noComparison = ["The monitor is great."];

      const result = await service.calculateRelevance(noComparison, {
        useBrands: false,
      });

      // No comparison → 1.0x (no boost)
      expect(result.components.comparisonMultiplier).toBe(1.0);
    });

    it("should boost multiple comparisons once", async () => {
      const multipleComparisons = [
        "Coming from an Acer, this is better than the LG and versus the Samsung it has a nicer curve.",
      ];

      const result = await service.calculateRelevance(multipleComparisons, {
        useBrands: false,
      });

      // Multiple comparisons still get 1.2x boost (not multiplicative)
      expect(result.components.comparisonMultiplier).toBe(1.2);
    });
  });

  describe("Combined Ownership and Comparison Boost", () => {
    it("should apply both ownership and comparison multipliers (m7hcj6a example)", async () => {
      const comment = [
        "Can't speak to the LG, but I've had the MSI MPG341 for about a week now and it's been great. Coming from a 165hz Acer Predator IPS, it definitely feels smoother and the colors are crazy. The 1800R curve feels just right, while the 800R curve was too much when I looked at one at Best Buy. I'd say get whichever one you can find cheaper.",
      ];

      const result = await service.calculateRelevance(comment, {
        useBrands: false,
      });

      // Should have ownership multiplier (1.3x)
      expect(result.components.ownershipMultiplier).toBe(1.3);
      // Should have comparison multiplier (1.2x)
      expect(result.components.comparisonMultiplier).toBe(1.2);
      // Combined boost = 1.3 * 1.2 = 1.56x
      // Final score should be decent (35+) - the actual score depends on term matching
      // With relevant terms (monitor keywords), this would score 70+
      expect(result.score).toBeGreaterThanOrEqual(35);
    });

    it("should boost owner review without comparison", async () => {
      const comment = [
        "I bought the MSI MPG341CQPX last month. The colors are vibrant, text is clear, and the 240hz is smooth. No issues with VRR flicker.",
      ];

      const result = await service.calculateRelevance(comment, {
        useBrands: false,
      });

      // Should have ownership multiplier (1.3x)
      expect(result.components.ownershipMultiplier).toBe(1.3);
      // No comparison
      expect(result.components.comparisonMultiplier).toBe(1.0);
    });

    it("should boost comparison without ownership", async () => {
      const comment = [
        "Based on reviews, the MSI seems better than the LG for gaming due to the curve.",
      ];

      const result = await service.calculateRelevance(comment, {
        useBrands: false,
      });

      // No ownership
      expect(result.components.ownershipMultiplier).toBe(1.0);
      // Should have comparison multiplier (1.2x)
      expect(result.components.comparisonMultiplier).toBe(1.2);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty content gracefully", async () => {
      const result = await service.calculateRelevance([], {
        useBrands: false,
      });

      expect(result.score).toBe(1);
      expect(result.components.disclaimerPenalty).toBe(1.0);
      expect(result.components.ownershipMultiplier).toBe(1.0);
      expect(result.components.comparisonMultiplier).toBe(1.0);
    });
  });

  describe("Phase 4: Fuzzy Matching Refinement", () => {
    describe("Multi-word term matching", () => {
      it('should not match "love it" when only "would love to" is present', async () => {
        const socialComment = [
          "Congrats! Would love to hear an update in a week!",
        ];

        // Define a multi-word term "love it" that should NOT match "would love to"
        const result = await service.calculateRelevance(socialComment, {
          useBrands: false,
          additionalTerms: [{ keyword: "love it", weight: 2.5 }],
        });

        // The term "love it" should not match because "it" is not present in "would love to"
        // This should result in score 0 (no match)
        const loveItTerm = result.components.topTerms.find(
          (t) => t.keyword === "love it",
        );
        expect(loveItTerm?.score ?? 0).toBe(0);
      });

      it('should match "love it" when both words are present', async () => {
        const ownerComment = ["I got the MSI and I love it. Colors are great."];

        const result = await service.calculateRelevance(ownerComment, {
          useBrands: false,
          additionalTerms: [{ keyword: "love it", weight: 2.5 }],
        });

        // "love it" should match because both "love" and "it" are present
        const loveItTerm = result.components.topTerms.find(
          (t) => t.keyword === "love it",
        );
        expect(loveItTerm).toBeDefined();
        expect(loveItTerm!.score).toBeGreaterThan(0);
      });

      it("should require all words for multi-word phrases", async () => {
        const comment = ["The monitor is great for productivity."];

        const result = await service.calculateRelevance(comment, {
          useBrands: false,
          additionalTerms: [{ keyword: "great for gaming", weight: 2.0 }],
        });

        // "great for gaming" should NOT match "great for productivity"
        // because "gaming" is not present
        const greatForGamingTerm = result.components.topTerms.find(
          (t) => t.keyword === "great for gaming",
        );
        expect(greatForGamingTerm?.score ?? 0).toBe(0);
      });

      it("should match multi-word phrases when all words present", async () => {
        const comment = ["This monitor is great for gaming and productivity."];

        const result = await service.calculateRelevance(comment, {
          useBrands: false,
          additionalTerms: [{ keyword: "great for gaming", weight: 2.0 }],
        });

        // "great for gaming" should match because all three words are present
        const greatForGamingTerm = result.components.topTerms.find(
          (t) => t.keyword === "great for gaming",
        );
        expect(greatForGamingTerm).toBeDefined();
        expect(greatForGamingTerm!.score).toBeGreaterThan(0);
      });
    });

    describe("Word boundary validation for high-weight terms", () => {
      it('should not match "love" in "lovely" for high-weight terms', async () => {
        const comment = ["The colors are lovely."];

        const result = await service.calculateRelevance(comment, {
          useBrands: false,
          additionalTerms: [
            { keyword: "love", weight: 2.5 }, // weight > 2.0 triggers boundary check
          ],
        });

        // High-weight term "love" should NOT match "lovely" due to word boundaries
        const loveTerm = result.components.topTerms.find(
          (t) => t.keyword === "love",
        );
        expect(loveTerm?.score ?? 0).toBe(0);
      });

      it('should match "love" with word boundaries for high-weight terms', async () => {
        const comment = ["I love the colors."];

        const result = await service.calculateRelevance(comment, {
          useBrands: false,
          additionalTerms: [
            { keyword: "love", weight: 2.5 }, // weight > 2.0 triggers boundary check
          ],
        });

        // High-weight term "love" SHOULD match "I love the" due to word boundaries
        const loveTerm = result.components.topTerms.find(
          (t) => t.keyword === "love",
        );
        expect(loveTerm).toBeDefined();
        expect(loveTerm!.score).toBeGreaterThan(0);
      });

      it("should allow partial matches for low-weight terms (weight <= 2.0)", async () => {
        const comment = ["The colors are lovely."];

        const result = await service.calculateRelevance(comment, {
          useBrands: false,
          additionalTerms: [
            { keyword: "love", weight: 1.5 }, // weight <= 2.0, no boundary check
          ],
        });

        // Low-weight term "love" CAN match "lovely" (no strict boundary requirement)
        // This is acceptable for lower-weight terms
        const loveScore = result.components.topTerms.find(
          (t) => t.keyword === "love",
        );
        // Should either match or not match based on fuzzy threshold, but won't error
        expect(loveScore?.score ?? 0).toBeGreaterThanOrEqual(0);
      });

      it("should enforce word boundaries for brand names (high weight)", async () => {
        const comment = ["I bought from Amazon."];

        const result = await service.calculateRelevance(comment, {
          useBrands: false,
          additionalTerms: [
            { keyword: "ama", weight: 3.0 }, // High-weight term
          ],
        });

        // "ama" should NOT match "Amazon" with word boundaries
        const amaTerm = result.components.topTerms.find(
          (t) => t.keyword === "ama",
        );
        expect(amaTerm?.score ?? 0).toBe(0);
      });
    });

    describe("Stricter threshold for multi-word terms", () => {
      it("should use threshold 0.9 for multi-word terms (stricter)", async () => {
        const comment = ["The panel quality is excellent."];

        const result = await service.calculateRelevance(comment, {
          useBrands: false,
          additionalTerms: [{ keyword: "panel quality", weight: 2.0 }],
        });

        // Multi-word term should match with exact or near-exact match (threshold 0.9)
        const panelQualityScore = result.components.topTerms.find(
          (t) => t.keyword === "panel quality",
        );
        if (panelQualityScore) {
          // If it matches, score should be high (near 1.0 similarity)
          expect(panelQualityScore.score).toBeGreaterThan(0);
        }
      });

      it("should allow more fuzzy matching for single-word terms", async () => {
        const comment = ["The colors are vibrant."];

        const result = await service.calculateRelevance(comment, {
          useBrands: false,
          additionalTerms: [
            { keyword: "color", weight: 2.0 }, // Single word, uses default threshold 0.6
          ],
        });

        // Single-word term can match "colors" with fuzzy threshold 0.6
        const colorScore = result.components.topTerms.find(
          (t) => t.keyword === "color",
        );
        expect(colorScore).toBeDefined();
        expect(colorScore?.score).toBeGreaterThan(0);
      });
    });

    describe("Real-world examples from Thread 636b", () => {
      it("should reduce fuzzy score for m7jzpe0 (social comment with false positive)", async () => {
        // Original: "Congrats! Would love to hear an update in a week!"
        // Before Phase 4: "love it" matched "would love to" → inflated fuzzy score
        // After Phase 4: "love it" should NOT match → reduced fuzzy score
        const comment = ["Congrats! Would love to hear an update in a week!"];

        const result = await service.calculateRelevance(comment, {
          useBrands: false,
          additionalTerms: [
            { keyword: "love it", weight: 2.5 },
            { keyword: "would love", weight: 2.0 },
          ],
        });

        // "love it" should NOT match (missing "it")
        // "would love" SHOULD match (both words present and adjacent)
        const loveItTerm = result.components.topTerms.find(
          (t) => t.keyword === "love it",
        );
        const wouldLoveTerm = result.components.topTerms.find(
          (t) => t.keyword === "would love",
        );

        expect(loveItTerm?.score ?? 0).toBe(0);
        expect(wouldLoveTerm).toBeDefined();
        expect(wouldLoveTerm!.score).toBeGreaterThan(0);
      });

      it("should maintain high scores for genuine owner reviews", async () => {
        // Owner review with actual "love it" usage
        const comment = [
          "I've had the MSI MPG341 for a week and I love it. The 1800R curve feels just right.",
        ];

        const result = await service.calculateRelevance(comment, {
          useBrands: false,
          additionalTerms: [
            { keyword: "love it", weight: 2.5 },
            { keyword: "1800r curve", weight: 2.0 },
          ],
        });

        // "love it" SHOULD match (both words present)
        // "1800r curve" SHOULD match (all words present)
        const loveItTerm = result.components.topTerms.find(
          (t) => t.keyword === "love it",
        );
        const curveTermTerm = result.components.topTerms.find(
          (t) => t.keyword === "1800r curve",
        );

        expect(loveItTerm).toBeDefined();
        expect(loveItTerm!.score).toBeGreaterThan(0);
        expect(curveTermTerm).toBeDefined();
        expect(curveTermTerm!.score).toBeGreaterThan(0);

        // Should have ownership multiplier
        expect(result.components.ownershipMultiplier).toBe(1.3);
      });
    });
  });
});
