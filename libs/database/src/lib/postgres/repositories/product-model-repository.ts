import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BasePostgresRepository } from './base-postgres-repository';
import { ProductModel } from '../models/product-model.entity';
import { nameOf } from '@fittkereso-backend/utils';
import { ProductCategory } from '../models';

@Injectable()
export class ProductModelRepository extends BasePostgresRepository<ProductModel> {
  constructor(
    @InjectRepository(ProductModel, 'postgres')
    repository: Repository<ProductModel>,
  ) {
    super(repository, ProductModel);
  }

  public async findByIdForPipeline(id: string): Promise<ProductModel | null> {
    return this.repo.findOne({
      where: { id },
      relations: [
        nameOf<ProductModel>('brand'),
        nameOf<ProductModel>('productCategory'),
        nameOf<ProductModel>('sources'),
      ],
    });
  }

  public async findByCategoryId(categoryId: string): Promise<ProductModel[]> {
    return this.repo
      .createQueryBuilder('productModel')
      .leftJoinAndSelect(
        `productModel.${nameOf<ProductModel>('productCategory')}`,
        'productCategory',
      )
      .where(`productCategory.${nameOf<ProductCategory>('id')} = :categoryId`, {
        categoryId,
      })
      .getMany();
  }
}
