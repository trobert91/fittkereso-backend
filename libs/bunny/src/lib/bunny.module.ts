import { Module } from '@nestjs/common';
import { BunnyStorageService } from './services/bunny-storage.service';
import { HttpModule } from '@nestjs/axios';
import { BunnyFileUploadService } from './services/bunny-file-upload.service';
import { BunnyStorageUrlService } from './services/bunny-storage-url.service';

@Module({
  imports: [HttpModule],
  controllers: [],
  providers: [
    BunnyFileUploadService,
    BunnyStorageService,
    BunnyStorageUrlService,
  ],
  exports: [BunnyStorageService],
})
export class BunnyModule {}
