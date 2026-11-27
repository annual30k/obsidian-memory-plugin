/**
 * The export bundle's container: a gzip-compressed POSIX tar (ustar, with PAX records for long or
 * non-ASCII names), optionally wrapped in passphrase encryption. Pure Node (zlib, crypto), so it works
 * the same on macOS, Windows and Linux without a system tar, and `tar -xzf` can still open a plain one.
 *
 * Reading treats the bundle as untrusted: only regular files and directories, every name checked by
 * safeEntryName, bounded sizes, and nothing is ever written or executed here.
 */

import crypto from "node:crypto";
import zlib from "node:zlib";

const BLOCK = 512;
export const ENCRYPTED_MAGIC = Buffer.from("OMVAULT-ENC1\n", "utf8");
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 200000;

// ---------------------------------------------------------------- names

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/iu;

/**
 * Why an archive member name is unsafe to extract anywhere, or null when it is fine: relative POSIX
 * path, no "..", ".", empty or absolute segments, no drive letter, backslash, control or
 * Windows-invalid characters, no trailing dot/space and no reserved device name (so the same bundle
 * extracts identically on all three systems).
 */
export function unsafeEntryReason(name) {
  if (typeof name !== "string" || !name) return "empty name";
  if (name.length > 4096) return "name too long";
  if (/[\u0000-\u001f\u007f]/u.test(name)) return "control character";
  if (name.includes("\\")) return "backslash";
  if (name.startsWith("/") || /^[A-Za-z]:/u.test(name)) return "absolute path";
  if (/[<>:"|?*]/u.test(name)) return "character not allowed on Windows";
  for (const seg of name.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return "path segment '" + seg + "'";
    if (/[. ]$/u.test(seg)) return "segment ends with a dot or space";
    if (WINDOWS_RESERVED.test(seg)) return "reserved Windows name";
  }
  return null;
}

// ---------------------------------------------------------------- writing

function octal(value, width) {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name, size, mtime, type) {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, "utf8");
  h.write(octal(type === "5" ? 0o755 : 0o644, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii");
  h.write(octal(0, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(Math.max(0, Math.floor(mtime / 1000)), 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write(type, 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(octal(sum, 7) + " ", 148, 8, "ascii");
  return h;
}

function pad(size) {
  const rest = size % BLOCK;
  return rest ? Buffer.alloc(BLOCK - rest, 0) : Buffer.alloc(0);
}

function paxRecord(key, value) {
  // "<len> path=<value>\n", where len counts the whole record including its own digits.
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body, "utf8");
  let len = bodyLen + String(bodyLen).length;
  while (bodyLen + String(len).length !== len) len = bodyLen + String(len).length;
  return Buffer.from(`${len}${body}`, "utf8");
}

/**
 * entries: [{ name, data: Buffer }] (files; parent directories are implied). Returns the gzip Buffer.
 * Every name must pass unsafeEntryReason.
 */
export function createTarGz(entries, { mtime = Date.now() } = {}) {
  const parts = [];
  for (const entry of entries) {
    const reason = unsafeEntryReason(entry.name);
    if (reason) throw new Error(`cannot archive ${JSON.stringify(entry.name)}: ${reason}`);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "");
    const time = entry.mtime ?? mtime;
    let name = entry.name;
    if (Buffer.byteLength(name, "utf8") > 100 || /[^\x20-\x7e]/u.test(name)) {
      const pax = paxRecord("path", name);
      parts.push(header("PaxHeader/" + crypto.createHash("sha1").update(name).digest("hex").slice(0, 16), pax.length, time, "x"), pax, pad(pax.length));
      name = name.replace(/[^\x20-\x7e]/gu, "_").slice(-100);
    }
    parts.push(header(name, data.length, time, "0"), data, pad(data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

// ---------------------------------------------------------------- reading

function readOctal(buf, start, len) {
  const s = buf.toString("ascii", start, start + len).replace(/\0.*$/su, "").trim();
  if (!s) return 0;
  if (!/^[0-7]+$/u.test(s)) throw new Error("corrupt tar header");
  return parseInt(s, 8);
}

function readString(buf, start, len) {
  const end = buf.indexOf(0, start);
  return buf.toString("utf8", start, end === -1 || end > start + len ? start + len : end);
}

function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const len = parseInt(data.toString("ascii", i, space), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > data.length) throw new Error("corrupt PAX record");
    const record = data.toString("utf8", space + 1, i + len - 1);
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Returns { files: [{ name, data }], rejected: [{ name, reason }] }. Throws on a corrupt or oversized
 * archive. Directories are dropped (they are implied by file names); links and devices are rejected.
 */
export function readTarGz(gz, { maxBytes = DEFAULT_MAX_BYTES, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  let tar;
  try {
    tar = zlib.gunzipSync(gz, { maxOutputLength: maxBytes });
  } catch (error) {
    throw new Error(/maxOutputLength|buffer|Cannot create a Buffer/iu.test(String(error?.message)) ? "bundle is larger than the import limit" : `not a gzip bundle (${error.message})`);
  }
  const files = [];
  const rejected = [];
  let offset = 0;
  let pax = null;
  let longName = null;
  let count = 0;
  while (offset + BLOCK <= tar.length) {
    const h = tar.subarray(offset, offset + BLOCK);
    if (h.every((b) => b === 0)) break;
    if (++count > maxEntries) throw new Error("bundle has too many entries");
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== readOctal(h, 148, 8)) throw new Error("corrupt tar header (checksum)");
    const size = readOctal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const dataStart = offset + BLOCK;
    if (dataStart + size > tar.length) throw new Error("truncated bundle");
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (type === "x") { pax = parsePax(data); continue; }
    if (type === "g") continue;
    if (type === "L") { longName = readString(data, 0, data.length); continue; }
    const prefix = readString(h, 345, 155);
    let name = pax?.path ?? longName ?? (prefix ? `${prefix}/${readString(h, 0, 100)}` : readString(h, 0, 100));
    pax = null;
    longName = null;
    if (type === "5") continue;
    name = name.replace(/^\.\//u, "");
    if (type !== "0" && type !== "\0" && type !== "7") { rejected.push({ name, reason: `not a regular file (type ${type})` }); continue; }
    const reason = unsafeEntryReason(name);
    if (reason) { rejected.push({ name, reason }); continue; }
    files.push({ name, data: Buffer.from(data) });
  }
  return { files, rejected };
}

// ---------------------------------------------------------------- encryption

export function isEncrypted(buffer) {
  return buffer.length > ENCRYPTED_MAGIC.length && buffer.subarray(0, ENCRYPTED_MAGIC.length).equals(ENCRYPTED_MAGIC);
}

/** scrypt-derived key, AES-256-GCM. Layout: magic | salt(16) | iv(12) | ciphertext | tag(16). */
export function encryptBundle(plain, passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 8) throw new Error("passphrase must be at least 8 characters");
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(ENCRYPTED_MAGIC);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([ENCRYPTED_MAGIC, salt, iv, body, cipher.getAuthTag()]);
}

export function decryptBundle(buffer, passphrase) {
  if (!isEncrypted(buffer)) return buffer;
  if (typeof passphrase !== "string" || !passphrase) throw new Error("this bundle is encrypted: a passphrase is required");
  const m = ENCRYPTED_MAGIC.length;
  if (buffer.length < m + 16 + 12 + 16) throw new Error("truncated encrypted bundle");
  const salt = buffer.subarray(m, m + 16);
  const iv = buffer.subarray(m + 16, m + 28);
  const tag = buffer.subarray(buffer.length - 16);
  const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(ENCRYPTED_MAGIC);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(buffer.subarray(m + 28, buffer.length - 16)), decipher.final()]);
  } catch {
    throw new Error("wrong passphrase or damaged bundle");
  }
}

export function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
