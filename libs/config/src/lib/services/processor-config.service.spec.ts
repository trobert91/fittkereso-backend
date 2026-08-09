import { Test, TestingModule } from "@nestjs/testing";
import { ProcessorConfigService } from "./processor-config.service";
import { DynamicConfigService } from "@ebike-backend/dynamic-config";

describe("ProcessorConfigService", () => {
  let service: ProcessorConfigService;
  let mockDynamicConfig: { processor: any; resolution: any };

  beforeEach(async () => {
    mockDynamicConfig = {
      processor: undefined,
      resolution: undefined,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProcessorConfigService,
        {
          provide: DynamicConfigService,
          useValue: mockDynamicConfig,
        },
      ],
    }).compile();

    service = module.get<ProcessorConfigService>(ProcessorConfigService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("relevance config", () => {
    it("should return default values when dynamic config is empty", () => {
      mockDynamicConfig.processor = undefined;

      const config = service.relevance;

      expect(config.minApprovalScore).toBe(42);
      expect(config.opBypassScore).toBe(1);
      expect(config.webSearchMinRelevance).toBe(60);
    });

    it("should return values from dynamic config when available", () => {
      mockDynamicConfig.processor = {
        relevance: {
          minApprovalScore: 60,
          opBypassScore: 2,
          webSearchMinRelevance: 65,
        },
      };

      const config = service.relevance;

      expect(config.minApprovalScore).toBe(60);
      expect(config.opBypassScore).toBe(2);
      expect(config.webSearchMinRelevance).toBe(65);
    });

    it("should handle partial config overrides", () => {
      mockDynamicConfig.processor = {
        relevance: {
          minApprovalScore: 55,
        },
      };

      const config = service.relevance;

      expect(config.minApprovalScore).toBe(55);
      expect(config.opBypassScore).toBe(1); // Default
      expect(config.webSearchMinRelevance).toBe(60); // Default
    });
  });

  describe("extraction config", () => {
    it("should return default values", () => {
      mockDynamicConfig.processor = undefined;

      const config = service.extraction;

      expect(config.minIngestionRelevance).toBe(50);
      expect(config.maxQuotesPerProduct).toBe(8);
    });

    it("should return overridden values from dynamic config", () => {
      mockDynamicConfig.processor = {
        extraction: {
          minIngestionRelevance: 70,
          maxQuotesPerProduct: 10,
        },
      };

      const config = service.extraction;

      expect(config.minIngestionRelevance).toBe(70);
      expect(config.maxQuotesPerProduct).toBe(10);
    });
  });

  describe("moderation config", () => {
    it("should return default values", () => {
      mockDynamicConfig.processor = undefined;

      const config = service.moderation;

      expect(config.minAutoApprovalScore).toBe(80);
      expect(config.maxReferenceFlags).toBe(2);
    });

    it("should return overridden values", () => {
      mockDynamicConfig.processor = {
        moderation: {
          minAutoApprovalScore: 90,
          maxReferenceFlags: 3,
        },
      };

      const config = service.moderation;

      expect(config.minAutoApprovalScore).toBe(90);
      expect(config.maxReferenceFlags).toBe(3);
    });
  });

  describe("pipeline config", () => {
    it("should return default values", () => {
      mockDynamicConfig.processor = undefined;

      const config = service.pipeline;

      expect(config.maxIterations).toBe(16);
      expect(config.maxParentProducts).toBe(6);
    });

    it("should return overridden values", () => {
      mockDynamicConfig.processor = {
        pipeline: {
          maxIterations: 20,
          maxParentProducts: 10,
        },
      };

      const config = service.pipeline;

      expect(config.maxIterations).toBe(20);
      expect(config.maxParentProducts).toBe(10);
    });
  });

  describe("thresholds", () => {
    it("should return all configs in one object", () => {
      mockDynamicConfig.processor = {
        relevance: { minApprovalScore: 55 },
        extraction: { minIngestionRelevance: 60 },
        moderation: { minAutoApprovalScore: 85 },
        pipeline: { maxIterations: 20 },
      };

      const thresholds = service.thresholds;

      expect(thresholds.relevance.minApprovalScore).toBe(55);
      expect(thresholds.extraction.minIngestionRelevance).toBe(60);
      expect(thresholds.moderation.minAutoApprovalScore).toBe(85);
      expect(thresholds.pipeline.maxIterations).toBe(20);
    });
  });
});
