import {
  createCipheriv, createDecipheriv, createHash, randomBytes,
} from 'node:crypto';
import { ApiError } from './errors.js';

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function encryptSecret(value: string, encryptionKey: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(encryptionKey), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decryptSecret(
  encrypted: EncryptedSecret,
  encryptionKey: string,
): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(encryptionKey), encrypted.iv);
    decipher.setAuthTag(encrypted.tag);
    return Buffer.concat([
      decipher.update(encrypted.ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new ApiError(
      500,
      'connector_credential_decryption_failed',
      'the stored connector credential cannot be decrypted',
      'verify POOLSTATIS_CONNECTOR_ENCRYPTION_KEY matches the key used when the source was configured',
    );
  }
}

function deriveKey(value: string): Buffer {
  if (value.trim().length < 16) {
    throw new ApiError(
      503,
      'connector_encryption_not_configured',
      'connector encryption requires a secret of at least 16 characters',
      'set POOLSTATIS_CONNECTOR_ENCRYPTION_KEY before configuring external sources',
    );
  }
  return createHash('sha256').update(value, 'utf8').digest();
}
