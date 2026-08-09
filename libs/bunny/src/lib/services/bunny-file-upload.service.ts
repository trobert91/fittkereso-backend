import { Injectable } from "@nestjs/common";
import { firstValueFrom } from "rxjs";
import { BunnyUploadedFile } from "../models";
import * as fs from "fs";
import { BunnyConfigService } from "@ebike-backend/config";
import { compact } from "lodash";
import { HttpService } from "@nestjs/axios";
import { CustomLogger } from "@ebike-backend/logger";

@Injectable()
export class BunnyFileUploadService {
  private readonly logger = new CustomLogger(BunnyFileUploadService.name);

  constructor(
    private readonly bunnyConfig: BunnyConfigService,
    private readonly httpService: HttpService,
  ) {}

  public async uploadFile(
    path: string,
    fileName: string,
    file: Buffer | fs.ReadStream | string,
  ): Promise<BunnyUploadedFile> {
    let data: fs.ReadStream | Buffer;
    if (typeof file === "string") {
      data = fs.createReadStream(file);
    } else {
      data = file;
    }

    const url = this.bunnyConfig.url;

    let urlPath = "";
    try {
      urlPath = compact([path, fileName]).join("/");

      await firstValueFrom(
        this.httpService.put(urlPath, data, {
          baseURL: url,
          headers: {
            AccessKey: this.bunnyConfig.apiKey,
            "Content-Type": "application/octet-stream",
          },
          maxBodyLength: Infinity,
        }),
      );

      this.logger.debug(`✅ Uploaded file to Bunny Storage: ${urlPath}`);

      return {
        fileName,
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to upload file to Bunny Storage: ${urlPath}`,
        error,
      );
      throw error;
    }
  }

  public async deleteFile(path: string, fileName: string): Promise<void> {
    const url = this.bunnyConfig.url;

    let urlPath = "";
    try {
      urlPath = compact([path, fileName]).join("/");

      await firstValueFrom(
        this.httpService.delete(urlPath, {
          baseURL: url,
          headers: {
            AccessKey: this.bunnyConfig.apiKey,
            "Content-Type": "application/octet-stream",
          },
        }),
      );

      this.logger.debug(`✅ Deleted file from Bunny Storage: ${urlPath}`);
    } catch (error) {
      this.logger.error(
        `❌ Failed to delete file from Bunny Storage: ${urlPath}`,
        error,
      );
      throw error;
    }
  }
}
