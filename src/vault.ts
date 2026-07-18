import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appDir } from './config.js';

/**
 * Local encrypted secret vault (AES-256-GCM).
 * - vault.key: 32 random bytes (hex). Local-machine key material.
 * - vault.enc: {iv, tag, data} hex-encoded encrypted JSON map {NAME: value}.
 * Secret VALUES never leave this machine except directly to AWS Secrets Manager.
 */

function keyPath(): string {
  return path.join(appDir(), 'vault.key');
}
function vaultPath(): string {
  return path.join(appDir(), 'vault.enc');
}

function loadKey(): Buffer {
  if (!fs.existsSync(keyPath())) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath(), key.toString('hex'), { mode: 0o600 });
    return key;
  }
  return Buffer.from(fs.readFileSync(keyPath(), 'utf8').trim(), 'hex');
}

function readAll(): Record<string, string> {
  if (!fs.existsSync(vaultPath())) return {};
  const key = loadKey();
  const { iv, tag, data } = JSON.parse(fs.readFileSync(vaultPath(), 'utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const plain = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function writeAll(map: Record<string, string>): void {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(map), 'utf8'), cipher.final()]);
  const payload = {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('hex'),
  };
  fs.writeFileSync(vaultPath(), JSON.stringify(payload), { mode: 0o600 });
}

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export function setSecret(name: string, value: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid secret name "${name}" (use UPPER_SNAKE_CASE)`);
  }
  if (!value) throw new Error('Secret value must not be empty');
  const map = readAll();
  map[name] = value;
  writeAll(map);
}

export function getSecret(name: string): string | null {
  return readAll()[name] ?? null;
}

export function listSecretNames(): string[] {
  return Object.keys(readAll()).sort();
}

/** Internal: full map, used by the scrubber only. Never expose over HTTP. */
export function _allSecretsForScrubbing(): Record<string, string> {
  return readAll();
}
