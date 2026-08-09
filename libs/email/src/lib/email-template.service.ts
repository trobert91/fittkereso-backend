import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class EmailTemplateService {
  private readonly templateDir = path.join(__dirname, 'templates');

  render(
    templateName: string,
    params: Record<string, string>,
  ): { html: string; text: string } {
    const html = this.loadAndInterpolate(`${templateName}.html`, params);
    const text = this.loadAndInterpolate(`${templateName}.txt`, params);
    return { html, text };
  }

  private loadAndInterpolate(
    fileName: string,
    params: Record<string, string>,
  ): string {
    const filePath = path.join(this.templateDir, fileName);
    let content = fs.readFileSync(filePath, 'utf-8');
    for (const [key, value] of Object.entries(params)) {
      content = content.replace(
        new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
        value,
      );
    }
    return content;
  }
}
