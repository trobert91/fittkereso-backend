import { Injectable } from "@nestjs/common";
import * as fs from "fs";
import { BunnyUploadedFile } from "../models/bunny-uploaded-file";
import { CustomLogger } from "@ebike-backend/logger";
import { BunnyFileUploadService } from "./bunny-file-upload.service";
import { BunnyStorageUrlService } from "./bunny-storage-url.service";

@Injectable()
export class BunnyStorageService {
  private readonly logger = new CustomLogger(BunnyStorageService.name);

  constructor(
    private readonly bunnyFileUploadService: BunnyFileUploadService,
    private readonly bunnyStorageUrlService: BunnyStorageUrlService,
  ) {}

  /**
   * Uploads a file to Bunny Storage.
   * @param path - Remote file path inside the storage zone (e.g. "products/1234/image.jpg")
   * @param file - Either a Buffer, a ReadStream, or a local file path string
   */
  public async uploadFile(
    path: string,
    fileName: string,
    file: Buffer | fs.ReadStream | string,
  ): Promise<BunnyUploadedFile> {
    return this.bunnyFileUploadService.uploadFile(path, fileName, file);
  }

  public getFileUrl(path: string, fileName: string): string {
    return this.bunnyStorageUrlService.getFileUrl(path, fileName);
  }

  public async deleteFile(path: string, fileName: string): Promise<void> {
    try {
      await this.bunnyFileUploadService.deleteFile(path, fileName);
    } catch (error) {
      if ((error as any).response?.status === 404) {
        this.logger.warn(
          `File not found (already deleted?): ${path}/${fileName}`,
        );
        return;
      }
      throw error;
    }
  }
}
