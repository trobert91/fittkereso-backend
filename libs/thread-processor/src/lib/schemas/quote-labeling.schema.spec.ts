import { Sentiment } from "@ebike-backend/database";
import { buildLabelingJsonSchema } from "./quote-labeling.schema";

interface EvidenceProps {
  label: { type: string };
  sentiment: { type: string; enum: string[] };
}
interface IssueProps {
  label: { type: string; enum: string[] };
  sentiment: { type: string; enum: string[] };
}
interface QuoteProps {
  quoteIndex: { type: string };
  speculative: { type: string };
  features: {
    type: string;
    items: { properties: EvidenceProps; required: string[] };
  };
  useCases: {
    type: string;
    items: { properties: EvidenceProps; required: string[] };
  };
  issues?: {
    type: string;
    items: { properties: IssueProps; required: string[] };
  };
}

describe("buildLabelingJsonSchema", () => {
  function getQuoteProps(
    schema: ReturnType<typeof buildLabelingJsonSchema>,
  ): QuoteProps {
    return schema.properties.products.items.properties.quotes.items
      .properties as unknown as QuoteProps;
  }

  function getEvidenceItem(schema: ReturnType<typeof buildLabelingJsonSchema>) {
    return getQuoteProps(schema).features.items;
  }

  it("exposes issues as a peer array on the quote with a label enum and negative-only sentiment", () => {
    const schema = buildLabelingJsonSchema(["vrr black screen", "coil whine"]);
    const quoteProps = getQuoteProps(schema);
    expect(quoteProps.issues).toBeDefined();
    expect(quoteProps.issues!.items.properties).toEqual({
      label: { type: "string", enum: ["vrr black screen", "coil whine"] },
      sentiment: {
        type: "string",
        enum: [Sentiment.Negative, Sentiment.StrongNegative],
      },
    });
    expect(quoteProps.issues!.items.required).toEqual(["label", "sentiment"]);
  });

  it("exposes a quote-level speculative boolean", () => {
    const schema = buildLabelingJsonSchema(["burn-in"]);
    const quoteProps = getQuoteProps(schema);
    expect(quoteProps.speculative).toEqual({ type: "boolean" });
  });

  it("omits the issues array entirely when the allowed list is empty", () => {
    const schema = buildLabelingJsonSchema([]);
    const quoteProps = getQuoteProps(schema);
    expect(quoteProps).not.toHaveProperty("issues");
    // Sanity: features and useCases still present.
    expect(quoteProps).toHaveProperty("features");
    expect(quoteProps).toHaveProperty("useCases");
  });

  it("feature and use-case evidence carry optional sentiment (not verdict) and no issue-only fields or speculative", () => {
    const schema = buildLabelingJsonSchema(["burn-in"]);
    const evidence = getEvidenceItem(schema);
    expect(evidence.properties).not.toHaveProperty("issueType");
    expect(evidence.properties).not.toHaveProperty("type");
    expect(evidence.properties).not.toHaveProperty("speculative");
    expect(evidence.properties).not.toHaveProperty("verdict");
    expect(evidence.properties).toHaveProperty("label");
    expect(evidence.properties).toHaveProperty("sentiment");
    expect(evidence.properties.sentiment).toEqual({
      type: "string",
      enum: Object.values(Sentiment),
    });
    expect(evidence.required).toEqual(["label"]);
  });

  it("applies the same evidence shape to features and useCases", () => {
    const schema = buildLabelingJsonSchema(["burn-in"]);
    const quoteProps = getQuoteProps(schema);
    expect(quoteProps.features.items).toEqual(quoteProps.useCases.items);
  });

  it("does not include a specs property on the product schema", () => {
    const schema = buildLabelingJsonSchema(["vrr black screen"]);
    const productProps = schema.properties.products.items.properties;
    expect(productProps).not.toHaveProperty("specs");
    expect(productProps).toHaveProperty("productId");
    expect(productProps).toHaveProperty("quotes");
    expect(productProps).toHaveProperty("referenceDetails");
  });

  describe("referenceLabels (ref-level evidence)", () => {
    it("exposes referenceLabels as an optional product-level property with features + useCases", () => {
      const schema = buildLabelingJsonSchema(["vrr black screen"]);
      const productProps = schema.properties.products.items.properties as {
        referenceLabels?: unknown;
      };
      expect(productProps).toHaveProperty("referenceLabels");

      const refLabels = productProps.referenceLabels as {
        type: string;
        properties: { features?: unknown; useCases?: unknown };
        additionalProperties: boolean;
      };
      expect(refLabels.type).toBe("object");
      expect(refLabels.properties).toHaveProperty("features");
      expect(refLabels.properties).toHaveProperty("useCases");
      expect(refLabels.additionalProperties).toBe(false);

      // The product schema must NOT require referenceLabels — it's optional by
      // design (the common case is to omit it entirely).
      const productItem = schema.properties.products.items as unknown as {
        required: readonly string[];
      };
      expect(productItem.required).not.toContain("referenceLabels");
    });

    it("referenceLabels.features and useCases reuse the open-vocab evidence shape", () => {
      const schema = buildLabelingJsonSchema([]);
      const productProps = schema.properties.products.items.properties as {
        referenceLabels: {
          properties: {
            features: { type: string; items: { properties: EvidenceProps } };
            useCases: { type: string; items: { properties: EvidenceProps } };
          };
        };
      };
      // No issueType, no enum on label — same as quote-level evidence.
      expect(
        productProps.referenceLabels.properties.features.items.properties,
      ).toEqual({
        label: { type: "string" },
        sentiment: { type: "string", enum: Object.values(Sentiment) },
      });
      expect(
        productProps.referenceLabels.properties.useCases.items.properties,
      ).toEqual(
        productProps.referenceLabels.properties.features.items.properties,
      );
    });
  });
});
