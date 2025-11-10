const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const SECRET = process.env.EMAIL_PASSWORD_SECRET || 'change-this-in-production-please';
const KEY = crypto.createHash('sha256').update(SECRET).digest();

const hashPassword = async (password) => {
  if (!password) {
    throw new Error('Password is required for hashing');
  }
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

const verifyPassword = async (password, hash) => {
  if (!hash) {
    return false;
  }
  return bcrypt.compare(password, hash);
};

const encryptPassword = (password) => {
  if (!password) {
    throw new Error('Password is required for encryption');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
};

const decryptPassword = (vault) => {
  if (!vault) {
    return null;
  }
  const [ivHex, tagHex, encryptedHex] = vault.split(':');
  if (!ivHex || !tagHex || !encryptedHex) {
    throw new Error('Invalid vault payload');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
};

module.exports = {
  hashPassword,
  verifyPassword,
  encryptPassword,
  decryptPassword,
};

