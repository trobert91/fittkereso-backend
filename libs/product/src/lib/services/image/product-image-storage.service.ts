import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import * as fs from 'fs';
import { extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { FileStorageService, UploadedFile } from '@fittkereso-backend/storage';

@Injectable()
export class ProductImageStorageService {
  constructor(
    private readonly storage: FileStorageService,
    private readonly http: HttpService, // optional
  ) {}

  async uploadLocal(
    productId: string,
    originalName: string,
    file: Buffer | fs.ReadStream | string,
  ): Promise<UploadedFile> {
    const ext = extname(originalName) || '.jpg';
    const fileName = `${uuidv4()}${ext}`;
    const path = this.buildPath(productId);

    return this.storage.uploadFile(path, fileName, file);
  }

  async uploadFromUrl(
    productId: string,
    imageUrl: string,
  ): Promise<UploadedFile> {
    const ext = extname(imageUrl) || '.jpg';
    const fileName = `${uuidv4()}${ext}`;
    const path = this.buildPath(productId);

    const buffer = await this.download(imageUrl);
    return this.storage.uploadFile(path, fileName, buffer);
  }

  private async download(url: string): Promise<Buffer> {
    const res = await this.http.axiosRef.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: { Accept: 'image/*' },
    });
    if (res.status !== 200) {
      throw new Error(`Download failed: ${url}`);
    }
    return Buffer.from(res.data, 'binary');
  }

  public async deleteFile(productId: string, fileName: string): Promise<void> {
    return this.storage.deleteFile(this.buildPath(productId), fileName);
  }

  private buildPath(productId: string): string {
    return `products/${productId}`;
  }
}
