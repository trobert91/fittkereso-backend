import { Module } from '@nestjs/common';
import { SerpApiService } from './services/serp-api.service';
import { HttpModule } from '@nestjs/axios';
import { DataforSeoRawHtmlService } from './services/raw-html.service';

@Module({
  imports: [HttpModule],
  providers: [DataforSeoRawHtmlService, SerpApiService],
  exports: [DataforSeoRawHtmlService, SerpApiService],
})
export class DataforseoModule {}
