import * as crypto from 'crypto';

export function generateNumericOtp(length: number = 6): string {
  const max = Math.pow(10, length);

  const randomNumber = crypto.randomInt(0, max);

  const otp = randomNumber.toString();

  return otp.padStart(length, '0');
}
