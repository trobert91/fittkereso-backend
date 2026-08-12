import { Module } from '@nestjs/common';
import { FileStorageService } from './services/file-storage.service';
import { BunnyModule } from '@fittkereso-backend/bunny';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [BunnyModule, HttpModule],
  controllers: [],
  providers: [FileStorageService],
  exports: [FileStorageService],
})
export class StorageModule {}
