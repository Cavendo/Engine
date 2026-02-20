import { generateWebhookSignature, verifyWebhookSignature } from '../utils/crypto.js';

describe('crypto webhook signature verification', () => {
  it('returns true for a valid signature', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const signature = generateWebhookSignature(payload, secret);

    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
  });

  it('returns false for mismatched signature length (no throw)', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';

    expect(() => verifyWebhookSignature(payload, 'abc', secret)).not.toThrow();
    expect(verifyWebhookSignature(payload, 'abc', secret)).toBe(false);
  });

  it('returns false for invalid signature value with same length', () => {
    const payload = '{"event":"test"}';
    const secret = 'whsec_test_secret';
    const badSignature = '0'.repeat(64);

    expect(verifyWebhookSignature(payload, badSignature, secret)).toBe(false);
  });
});
