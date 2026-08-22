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
    const ext = this.extnameFromUrl(imageUrl) || '.jpg';
    const fileName = `${uuidv4()}${ext}`;
    const path = this.buildPath(productId);

    const buffer = await this.download(imageUrl);
    return this.storage.uploadFile(path, fileName, buffer);
  }

  // extname() on the raw URL string picks up the query string/fragment
  // (e.g. "...1260044108.webp?lastmod=1761570968.1772457778" -> ".1772457778"
  // instead of ".webp") — parse the pathname first so only the real file
  // extension is used.
  private extnameFromUrl(imageUrl: string): string {
    try {
      return extname(new URL(imageUrl).pathname);
    } catch {
      return extname(imageUrl);
    }
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
