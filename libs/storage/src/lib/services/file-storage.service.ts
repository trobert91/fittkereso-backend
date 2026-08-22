import { Injectable } from '@nestjs/common';
import { BunnyStorageService } from '@fittkereso-backend/bunny';
import { retry } from '@fittkereso-backend/utils';
import { CustomLogger } from '@fittkereso-backend/logger';
import * as fs from 'fs';
import { UploadedFile } from '../models/uploaded-file';

const UPLOAD_RETRY_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAY_MS = 500;

@Injectable()
export class FileStorageService {
  private readonly logger = new CustomLogger(FileStorageService.name);

  constructor(private readonly bunnyStorageService: BunnyStorageService) {}

  public async uploadFile(
    path: string,
    fileName: string,
    file: Buffer | fs.ReadStream | string,
  ): Promise<UploadedFile> {
    // Only a Buffer is safe to retry — a ReadStream/path is consumed (or may
    // be) by the first attempt, so re-sending it could upload an empty or
    // truncated file. Every current caller passes a Buffer in practice
    // (e.g. Multer's in-memory file, or a downloaded image); a stream/path
    // input still uploads, just without retrying a transient failure.
    if (!Buffer.isBuffer(file)) {
      return this.bunnyStorageService.uploadFile(path, fileName, file);
    }

    let attempt = 0;
    return retry(
      () => {
        attempt++;
        return this.bunnyStorageService.uploadFile(path, fileName, file);
      },
      { attempts: UPLOAD_RETRY_ATTEMPTS, delayMs: UPLOAD_RETRY_DELAY_MS },
    ).catch((error) => {
      this.logger.warn(
        `Upload failed after ${attempt} attempt(s): ${path}/${fileName}`,
        { error },
      );
      throw error;
    });
  }

  public async deleteFile(path: string, fileName: string): Promise<void> {
    return this.bunnyStorageService.deleteFile(path, fileName);
  }

  public getFileUrl(path: string, fileName: string): string {
    return this.bunnyStorageService.getFileUrl(path, fileName);
  }
}
