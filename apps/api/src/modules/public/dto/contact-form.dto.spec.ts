import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ContactFormDto } from './contact-form.dto';

/** What the global ValidationPipe ({ transform: true }) does to a request body. */
function validate(body: Record<string, unknown>) {
  const dto = plainToInstance(ContactFormDto, body);
  return { dto, errors: validateSync(dto).map((e) => e.property) };
}

const VALID = {
  name: 'Kiss Anna',
  email: 'anna@example.com',
  message: 'Hello',
  recaptchaToken: 'token',
};

describe('ContactFormDto', () => {
  it('accepts a form without a phone number', () => {
    expect(validate(VALID).errors).toEqual([]);
  });

  it('treats a blank phone number as none', () => {
    const { dto, errors } = validate({ ...VALID, phone: '   ' });
    expect(errors).toEqual([]);
    expect(dto.phone).toBeUndefined();
  });

  it('accepts the usual ways of writing a phone number', () => {
    for (const phone of ['+36 30 123 4567', '06-30/123-4567', '(1) 234.5678']) {
      expect(validate({ ...VALID, phone }).errors).toEqual([]);
    }
  });

  it('refuses a phone number that is not one', () => {
    expect(validate({ ...VALID, phone: 'call me maybe' }).errors).toEqual(['phone']);
  });

  it('trims the fields, so a blank name or message is refused', () => {
    const { dto, errors } = validate({ ...VALID, name: '   ', message: ' \n ', email: ' anna@example.com ' });
    expect(errors).toEqual(['name', 'message']);
    expect(dto.email).toBe('anna@example.com');
  });

  it('refuses an overlong message', () => {
    expect(validate({ ...VALID, message: 'x'.repeat(5001) }).errors).toEqual(['message']);
  });
});
