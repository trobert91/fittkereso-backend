import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class EmailTemplateService {
  private readonly templateDir = path.join(__dirname, 'templates');

  /**
   * Fills `{{key}}` placeholders in `<name>.html` and `<name>.txt`.
   *
   * Values are HTML-escaped in the HTML part, never in the text part, and are
   * always treated as raw: some come from outside (a contact form's message, a
   * reset link carrying a caller's `next`), and an unescaped `&` alone breaks
   * an href in some mail clients.
   */
  render(
    templateName: string,
    params: Record<string, string>,
  ): { html: string; text: string } {
    const html = this.loadAndInterpolate(`${templateName}.html`, params, escapeHtml);
    const text = this.loadAndInterpolate(`${templateName}.txt`, params, (value) => value);
    return { html, text };
  }

  private loadAndInterpolate(
    fileName: string,
    params: Record<string, string>,
    encode: (value: string) => string,
  ): string {
    const filePath = path.join(this.templateDir, fileName);
    let content = fs.readFileSync(filePath, 'utf-8');
    for (const [key, value] of Object.entries(params)) {
      const encoded = encode(value);
      // A function, not the string itself: a string replacement expands `$&`
      // and `$'`, which a URL or a message can contain.
      content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => encoded);
    }
    return content;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
