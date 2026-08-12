import { Injectable } from '@nestjs/common';
import { ZyteScraperService } from '@fittkereso-backend/zyte';

@Injectable()
export class ScraperService {
  constructor(private readonly zyteScraperService: ZyteScraperService) {}

  public async getHtml(url: string): Promise<string> {
    return this.zyteScraperService.scrape(url);
  }
}
