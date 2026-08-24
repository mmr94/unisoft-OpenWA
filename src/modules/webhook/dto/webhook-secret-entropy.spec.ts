import { validate } from 'class-validator';
import { CreateWebhookDto, UpdateWebhookDto } from './webhook.dto';

/**
 * The HMAC secret signs every delivery this webhook fires. A short secret is recoverable
 * from one observed signature, which turns the signature from an integrity check into a forging
 * tool — 16 characters is the floor, not a recommendation.
 */
describe('CreateWebhookDto secret entropy', () => {
  const dtoWithSecret = (secret: string) => {
    const dto = new CreateWebhookDto();
    dto.url = 'https://receiver.example.com/hook';
    dto.events = ['message.received'];
    dto.secret = secret;
    return dto;
  };

  it('rejects a secret shorter than 16 characters', async () => {
    const errors = await validate(dtoWithSecret('short'));
    expect(errors.some(e => e.property === 'secret')).toBe(true);
  });

  it('accepts a 16+ character secret', async () => {
    const errors = await validate(dtoWithSecret('a-fully-entropic-secret'));
    expect(errors.some(e => e.property === 'secret')).toBe(false);
  });

  it('still allows omitting the secret entirely (unsigned webhooks are a valid choice)', async () => {
    const dto = new CreateWebhookDto();
    dto.url = 'https://receiver.example.com/hook';
    dto.events = ['message.received'];
    expect(errorsOf(await validate(dto))).toBe(0);
    function errorsOf(errs: { property: string }[]): number {
      return errs.filter(e => e.property === 'secret').length;
    }
  });
});

describe('UpdateWebhookDto secret entropy', () => {
  const dtoWithSecret = (secret: unknown) => {
    const dto = new UpdateWebhookDto();
    dto.secret = secret as string | undefined;
    return dto;
  };

  it('rejects rotating to a secret shorter than 16 characters', async () => {
    const errors = await validate(dtoWithSecret('short'));
    expect(errors.some(e => e.property === 'secret')).toBe(true);
  });

  it('accepts rotating to a 16+ character secret', async () => {
    const errors = await validate(dtoWithSecret('a-fully-entropic-secret'));
    expect(errors.some(e => e.property === 'secret')).toBe(false);
  });

  it('still accepts an empty string, which this route treats as clearing the secret', async () => {
    const errors = await validate(dtoWithSecret(''));
    expect(errors.some(e => e.property === 'secret')).toBe(false);
  });

  it('still allows leaving the secret out of the patch entirely', async () => {
    const errors = await validate(new UpdateWebhookDto());
    expect(errors.some(e => e.property === 'secret')).toBe(false);
  });

  it('still rejects a non-string value', async () => {
    const errors = await validate(dtoWithSecret(42));
    expect(errors.some(e => e.property === 'secret')).toBe(true);
  });
});
