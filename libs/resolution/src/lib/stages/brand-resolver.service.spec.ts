import type { BrandResolutionService } from "@ebike-backend/product";
import type { Brand } from "@ebike-backend/database";
import { BrandResolverService } from "./brand-resolver.service";
import { makeTestContext } from "../testing/make-context";

function makeBrandResolution(
  result?:
    | { entity: Pick<Brand, "id" | "name">; similarity: number }
    | undefined,
  throwError = false,
): BrandResolutionService {
  return {
    resolve: jest.fn().mockImplementation(async () => {
      if (throwError) throw new Error("boom");
      return result;
    }),
  } as unknown as BrandResolutionService;
}

describe("BrandResolverService", () => {
  it("writes ctx.brand when resolution succeeds", async () => {
    const brandResolution = makeBrandResolution({
      entity: { id: "brand-1", name: "MSI" } as Brand,
      similarity: 0.95,
    });
    const service = new BrandResolverService(brandResolution);

    const context = makeTestContext({ input: { brand: "msi" } });
    await service.resolve(context);

    expect(context.brand).toEqual({
      id: "brand-1",
      name: "MSI",
      similarity: 0.95,
    });
  });

  it("skips when ctx.brand is already set (Stage 1 path)", async () => {
    const brandResolution = makeBrandResolution();
    const service = new BrandResolverService(brandResolution);

    const context = makeTestContext({
      input: { brand: "msi" },
      brand: { id: "pre", name: "PreBrand", similarity: 1.0 },
    });
    await service.resolve(context);

    expect(brandResolution.resolve).not.toHaveBeenCalled();
    expect(context.brand).toEqual({
      id: "pre",
      name: "PreBrand",
      similarity: 1.0,
    });
  });

  it("records phase error and continues when resolution throws", async () => {
    const brandResolution = makeBrandResolution(undefined, true);
    const service = new BrandResolverService(brandResolution);

    const context = makeTestContext({ input: { brand: "msi" } });
    await service.resolve(context);

    expect(context.brand).toBeUndefined();
    expect(context.errors).toHaveLength(1);
    expect(context.errors[0].phase).toBe("brand_resolution");
    expect(context.errors[0].message).toBe("boom");
  });

  it("leaves ctx.brand unset when resolution returns undefined", async () => {
    const brandResolution = makeBrandResolution(undefined);
    const service = new BrandResolverService(brandResolution);

    const context = makeTestContext({ input: { brand: "unknown" } });
    await service.resolve(context);

    expect(context.brand).toBeUndefined();
    expect(context.errors).toHaveLength(0);
  });
});
