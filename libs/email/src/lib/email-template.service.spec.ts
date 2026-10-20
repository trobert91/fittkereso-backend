import * as path from 'path';
import { EmailTemplateService } from './email-template.service';

/**
 * Renders the real template files: the escaping matters most where an
 * outside value lands in markup, and only the files show where that is.
 */
describe('EmailTemplateService', () => {
  function makeService(): EmailTemplateService {
    const service = new EmailTemplateService();
    // The templates sit next to the source here; in the build they are
    // copied next to the bundle, which is what __dirname points at there.
    Object.assign(service, { templateDir: path.join(__dirname, 'templates') });

    return service;
  }

  it('escapes values in the HTML part', () => {
    const { html } = makeService().render('contact', {
      senderName: '<script>alert(1)</script>',
      senderEmail: 'a@example.com',
      message: 'Tom & "Jerry"',
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Tom &amp; &quot;Jerry&quot;');
  });

  it('leaves the text part unescaped', () => {
    const { text } = makeService().render('contact', {
      senderName: 'Tom & Jerry',
      senderEmail: 'a@example.com',
      message: '<hello>',
    });

    expect(text).toContain('Tom & Jerry');
    expect(text).toContain('<hello>');
  });

  it('keeps $ sequences in a value literally', () => {
    const { text } = makeService().render('contact', {
      senderName: "price $& $' $1",
      senderEmail: 'a@example.com',
      message: 'm',
    });

    expect(text).toContain("price $& $' $1");
  });

  it('escapes the ampersands of a reset link inside its href', () => {
    const resetUrl =
      'https://admin.example.com/auth/confirm?token_hash=abc&type=recovery&next=%2Fauth%2Fset-password';
    const { html, text } = makeService().render('password-reset', {
      email: 'someone@example.com',
      resetUrl,
      logoUrl: 'https://admin.example.com/email/fittkereso-mark.png',
      adminUrl: 'https://admin.example.com',
      adminHost: 'admin.example.com',
    });

    expect(html).toContain(
      'href="https://admin.example.com/auth/confirm?token_hash=abc&amp;type=recovery&amp;next=%2Fauth%2Fset-password"',
    );
    expect(html).toContain(
      'src="https://admin.example.com/email/fittkereso-mark.png"',
    );
    expect(html).not.toMatch(/\{\{\w+\}\}/);
    expect(text).toContain(resetUrl);
    expect(text).not.toMatch(/\{\{\w+\}\}/);
  });
});
