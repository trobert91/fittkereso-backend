import { Injectable } from "@nestjs/common";
import { BunnyStorageService } from "@ebike-backend/bunny";
import * as fs from "fs";
import { UploadedFile } from "../models/uploaded-file";

@Injectable()
export class FileStorageService {
  constructor(private readonly bunnyStorageService: BunnyStorageService) {}

  public async uploadFile(
    path: string,
    fileName: string,
    file: Buffer | fs.ReadStream | string,
  ): Promise<UploadedFile> {
    return this.bunnyStorageService.uploadFile(path, fileName, file);
  }

  public async deleteFile(path: string, fileName: string): Promise<void> {
    return this.bunnyStorageService.deleteFile(path, fileName);
  }

  public getFileUrl(path: string, fileName: string): string {
    return this.bunnyStorageService.getFileUrl(path, fileName);
  }
}
