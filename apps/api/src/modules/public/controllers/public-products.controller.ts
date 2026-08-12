import { Controller, Get, Param, SerializeOptions } from '@nestjs/common';
import { SerializeGroup } from '@fittkereso-backend/utils';
import { PublicProductsService } from '../services/public-products.service';
import { ProductListDto } from '../dto/product-list.dto';
import { ProductDetailDto } from '../dto/product-detail.dto';

@Controller('v1/public/products')
@SerializeOptions({ groups: [SerializeGroup.list, SerializeGroup.details] })
export class PublicProductsController {
  constructor(private readonly productsService: PublicProductsService) {}

  @Get('top')
  async getTopProducts(): Promise<ProductListDto[]> {
    return this.productsService.getTopProducts();
  }

  @Get(':slug')
  async getProductBySlug(
    @Param('slug') slug: string,
  ): Promise<ProductDetailDto> {
    return this.productsService.getProductBySlug(slug);
  }

  @Get(':slug/similar')
  async getSimilarProducts(
    @Param('slug') slug: string,
  ): Promise<ProductListDto[]> {
    return this.productsService.getSimilarProducts(slug);
  }
}
