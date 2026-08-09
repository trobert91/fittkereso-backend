/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions, TypeOrmOptionsFactory } from '@nestjs/typeorm';
import { join } from 'path';

@Injectable()
export class MongoConfigService implements TypeOrmOptionsFactory {
  constructor(private configService: ConfigService) {}
  createTypeOrmOptions(): TypeOrmModuleOptions | Promise<TypeOrmModuleOptions> {
    return {
      type: 'mongodb',
      url: this.url,
      entities: [join(__dirname, '../../../**/mongo/**/**.entity{.ts,.js}')],
      synchronize: true,
      logging: false,
    };
  }
  get url(): string {
    return this.configService.get<string>('mongo.url')!;
  }
}
