import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ProductCategory,
  ProductModelRepository,
  ProductModel,
} from '@fittkereso-backend/database';
import { DynamicConfigService } from '@fittkereso-backend/dynamic-config';
import { ProductImageDtoService } from '@fittkereso-backend/product';
import { nameOf } from '@fittkereso-backend/utils';

import { ProductListDto } from '../dto/product-list.dto';
import {
  ProductDetailDto,
  ProductImageDto,
  ShopLinkDto,
} from '../dto/product-detail.dto';
import { BrandDto } from '../dto/brand.dto';
import { MainImageDto } from '../dto/main-image.dto';
import { CategoryListDto } from '../dto/category.dto';

@Injectable()
export class PublicProductsService {
  constructor(
    private readonly productModelRepo: ProductModelRepository,
    private readonly dynamicConfigService: DynamicConfigService,
    private readonly productImageDtoService: ProductImageDtoService,
  ) {}

  async getTopProducts(): Promise<ProductListDto[]> {
    const products = await this.productModelRepo.repo
      .createQueryBuilder('product')
      .leftJoinAndSelect(`product.${nameOf<ProductModel>('brand')}`, 'brand')
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>('mainImage')}`,
        'mainImage',
      )
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>('productCategory')}`,
        'category',
      )
      .where(`product.${nameOf<ProductModel>('enabled')} = :enabled`, {
        enabled: true,
      })
      .orderBy(`product.${nameOf<ProductModel>('createdAt')}`, 'DESC')
      .limit(30)
      .getMany();

    this.productImageDtoService.updateProductImageUrls(products);
    return products.map((p) => this.toProductListDto(p));
  }

  async getProductBySlug(slug: string): Promise<ProductDetailDto> {
    const product = await this.productModelRepo.repo
      .createQueryBuilder('product')
      .leftJoinAndSelect(`product.${nameOf<ProductModel>('brand')}`, 'brand')
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>('productCategory')}`,
        'category',
      )
      .leftJoinAndSelect(`product.${nameOf<ProductModel>('images')}`, 'images')
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>('mainImage')}`,
        'mainImage',
      )
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>('aliases')}`,
        'aliases',
      )
      .where(`product.${nameOf<ProductModel>('slug')} = :slug`, { slug })
      .getOne();

    if (!product) {
      throw new NotFoundException(`Product with slug "${slug}" not found`);
    }

    this.productImageDtoService.updateProductImageUrls([product]);
    const shopLinks = this.enrichShopLinksWithAffiliateTag([]);

    const dto = new ProductDetailDto();
    dto.id = product.id;
    dto.slug = product.slug ?? '';
    dto.displayName = product.displayName;
    dto.model = product.model;
    dto.releaseYear = product.releaseYear;
    dto.description = product.description;
    dto.specs = product.specs;
    dto.orderedSpecs = product.orderedSpecs;
    dto.aliases = (product.aliases ?? []).map((a) => a.alias);
    dto.shopLinks = shopLinks;
    dto.categorySlug = product.productCategory?.slug ?? '';
    dto.categoryName = product.productCategory?.name ?? '';
    dto.images = (product.images ?? [])
      .sort((a, b) => a.order - b.order)
      .map((img) => {
        const imageDto = new ProductImageDto();
        imageDto.url = img.url ?? '';
        imageDto.order = img.order;
        return imageDto;
      });

    if (product.brand) {
      const brandDto = new BrandDto();
      brandDto.slug = product.brand.slug ?? '';
      brandDto.name = product.brand.name;
      dto.brand = brandDto;
    }

    if (product.mainImage) {
      const mainImageDto = new MainImageDto();
      mainImageDto.url = product.mainImage.url ?? '';
      dto.mainImage = mainImageDto;
    } else {
      dto.mainImage = null;
    }

    return dto;
  }

  enrichShopLinksWithAffiliateTag(
    links: { url: string; platform: string | null }[],
  ): ShopLinkDto[] {
    const affiliateTag = this.dynamicConfigService.general.amazonAffiliateTag;

    return links.map((link) => {
      let url = link.url;
      if (affiliateTag && link.platform?.toLowerCase() === 'amazon') {
        const separator = url.includes('?') ? '&' : '?';
        url = `${url}${separator}tag=${affiliateTag}`;
      }
      const dto = new ShopLinkDto();
      dto.url = url;
      dto.platform = link.platform;
      return dto;
    });
  }

  async getSimilarProducts(slug: string): Promise<ProductListDto[]> {
    const product = await this.productModelRepo.repo
      .createQueryBuilder('product')
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>('productCategory')}`,
        'category',
      )
      .where(`product.${nameOf<ProductModel>('slug')} = :slug`, { slug })
      .getOne();

    if (!product || !product.productCategory) {
      return [];
    }

    const similar = await this.productModelRepo.repo
      .createQueryBuilder('product')
      .leftJoinAndSelect(`product.${nameOf<ProductModel>('brand')}`, 'brand')
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>('mainImage')}`,
        'mainImage',
      )
      .leftJoinAndSelect(
        `product.${nameOf<ProductModel>('productCategory')}`,
        'category',
      )
      .where(`category.${nameOf<ProductCategory>('id')} = :categoryId`, {
        categoryId: product.productCategory.id,
      })
      .andWhere(`product.${nameOf<ProductModel>('enabled')} = :enabled`, {
        enabled: true,
      })
      .andWhere(`product.${nameOf<ProductModel>('id')} != :selfId`, {
        selfId: product.id,
      })
      .orderBy(`product.${nameOf<ProductModel>('createdAt')}`, 'DESC')
      .limit(4)
      .getMany();

    this.productImageDtoService.updateProductImageUrls(similar);
    return similar.map((p) => this.toProductListDto(p));
  }

  private toProductListDto(product: ProductModel): ProductListDto {
    const dto = new ProductListDto();
    dto.id = product.id;
    dto.slug = product.slug ?? '';
    dto.displayName = product.displayName;
    dto.model = product.model;
    dto.releaseYear = product.releaseYear;
    dto.orderedSpecs = product.orderedSpecs;

    if (product.brand) {
      const brandDto = new BrandDto();
      brandDto.slug = product.brand.slug ?? '';
      brandDto.name = product.brand.name;
      dto.brand = brandDto;
    }

    if (product.productCategory) {
      const categoryDto = new CategoryListDto();
      categoryDto.id = product.productCategory.id;
      categoryDto.slug = product.productCategory.slug ?? '';
      categoryDto.name = product.productCategory.name;
      dto.category = categoryDto;
    }

    if (product.mainImage) {
      const mainImageDto = new MainImageDto();
      mainImageDto.url = product.mainImage.url ?? '';
      dto.mainImage = mainImageDto;
    } else {
      dto.mainImage = null;
    }

    return dto;
  }
}
