import { Injectable } from "@nestjs/common";
import { BunnyConfigService } from "@ebike-backend/config";
import { compact } from "lodash";

@Injectable()
export class BunnyStorageUrlService {
  constructor(private readonly bunnyConfig: BunnyConfigService) {}

  public getFileUrl(path: string, fileName: string): string {
    return `${this.bunnyConfig.cdnUrl}/${compact([path, fileName]).join("/")}`;
  }
}
