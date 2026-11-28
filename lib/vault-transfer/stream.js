/**
 * Streaming bundle I/O for Vaults of any size: memory stays flat whatever the attachments weigh.
 *
 *   writeBundleFile   tar entries -> gzip -> (AES-256-GCM) -> file, reading each file in chunks
 *   readBundleFile    file -> (decrypt) -> gunzip -> tar entries, each written to a staging folder (or,
 *                     with stage: false, text kept in memory and binaries only hashed)
 *
 * Same container as archive.js (POSIX tar with PAX names, gzip, the OMVAULT-ENC1 envelope), so bundles
 * from either path open with either path. Names are checked with unsafeEntryReason exactly like the
 * in-memory reader, and nothing is ever executed.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { ENCRYPTED_MAGIC, unsafeEntryReason } from "./archive.js";

const BLOCK = 512;
const CHUNK = 1024 * 1024;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
// Decompressed-size guard against gzip bombs; far above any real Vault.
export const STREAM_MAX_BYTES = 200 * 1024 * 1024 * 1024;

// ---------------------------------------------------------------- tar headers

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

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body, "utf8");
  let len = bodyLen + String(bodyLen).length;
  while (bodyLen + String(len).length !== len) len = bodyLen + String(len).length;
  return Buffer.from(`${len}${body}`, "utf8");
}

const pad = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK, 0);

/** Header block(s) for one entry: a PAX record first when the name is long or not ASCII. */
export function entryHeaders(entryName, size, mtime, dir = false) {
  let name = dir ? `${entryName}/` : entryName;
  const out = [];
  if (Buffer.byteLength(name, "utf8") > 100 || /[^\x20-\x7e]/u.test(name)) {
    const pax = paxRecord("path", name);
    out.push(header("PaxHeader/" + crypto.createHash("sha1").update(name).digest("hex").slice(0, 16), pax.length, mtime, "x"), pax, pad(pax.length));
    name = name.replace(/[^\x20-\x7e]/gu, "_").slice(-100);
  }
  out.push(header(name, size, mtime, dir ? "5" : "0"));
  return out;
}

// ---------------------------------------------------------------- hashing files

/** sha256 of a file, read in chunks (constant memory). */
export function hashFileSync(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let n;
    while ((n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------- writing

/**
 * items: [{ name, dir: true } | { name, data: Buffer } | { name, abs, size, sha256 }]. Files given by
 * path are streamed in chunks and checked against their sha256 (a file changed during the export fails
 * it rather than shipping a mismatch). Written to `file` through a temporary name, then renamed.
 */
// Formats that are already compressed: deflating them again costs ~20x the time for no gain, so they
// are stored (level 0) inside the same gzip stream; notes and other text are compressed normally.
export const STORED_EXT = /\.(?:png|jpe?g|gif|webp|heic|heif|avif|mp4|mov|m4v|webm|mkv|mp3|m4a|aac|ogg|opus|flac|zip|gz|tgz|7z|rar|xz|bz2|zst|woff2?|pdf|docx|xlsx|pptx)$/iu;

export async function writeBundleFile(file, items, { passphrase = null, mtime = Date.now(), level = 6 } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  // One gzip *member* per run of same-level data, concatenated into one stream: every gunzip (Node's,
  // the system tar) reads them back to back. zlib's params() does not really switch to storing.
  const sink = new PassThrough();
  const tail = [sink];
  if (passphrase) tail.push(encryptStream(passphrase));
  tail.push(fs.createWriteStream(tmp, { mode: 0o600 }));
  const done = pipeline(...tail);
  let gzip = null;
  let current = null;
  const endMember = () => new Promise((resolve) => {
    if (!gzip) return resolve();
    gzip.once("end", resolve);
    gzip.end();
  });
  const setLevel = async (next) => {
    if (gzip && current === next) return;
    await endMember();
    gzip = zlib.createGzip({ level: next });
    gzip.pipe(sink, { end: false });
    current = next;
  };
  const put = async (chunk) => {
    if (!gzip) await setLevel(level);
    if (!gzip.write(chunk)) await new Promise((r) => gzip.once("drain", r));
  };
  try {
    for (const item of items) {
      const reason = unsafeEntryReason(item.name);
      if (reason) throw new Error(`cannot archive ${JSON.stringify(item.name)}: ${reason}`);
      if (item.dir) { for (const h of entryHeaders(item.name, 0, mtime, true)) await put(h); continue; }
      if (item.data) {
        for (const h of entryHeaders(item.name, item.data.length, mtime)) await put(h);
        await put(item.data);
        await put(pad(item.data.length));
        continue;
      }
      for (const h of entryHeaders(item.name, item.size, mtime)) await put(h);
      await setLevel(STORED_EXT.test(item.name) ? 0 : level);
      const h = crypto.createHash("sha256");
      const fh = await fs.promises.open(item.abs, "r");
      let total = 0;
      try {
        while (total < item.size) {
          const buf = Buffer.allocUnsafe(Math.min(CHUNK, item.size - total));
          const { bytesRead } = await fh.read(buf, 0, buf.length, null);
          if (bytesRead <= 0) break;
          const chunk = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
          h.update(chunk);
          total += bytesRead;
          await put(chunk);
        }
      } finally {
        await fh.close();
      }
      if (total !== item.size || h.digest("hex") !== item.sha256) throw new Error(`${item.name} changed while it was being exported; export again`);
      await put(pad(item.size));
      await setLevel(level);
    }
    await put(Buffer.alloc(BLOCK * 2, 0));
    await endMember();
    sink.end();
    await done;
    fs.renameSync(tmp, file);
  } catch (error) {
    gzip?.destroy();
    sink.destroy();
    await done.catch(() => {});
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function encryptStream(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 8) throw new Error("passphrase must be at least 8 characters");
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", crypto.scryptSync(passphrase, salt, 32, SCRYPT), iv);
  cipher.setAAD(ENCRYPTED_MAGIC);
  let started = false;
  return new Transform({
    transform(chunk, _enc, done) {
      if (!started) { this.push(Buffer.concat([ENCRYPTED_MAGIC, salt, iv])); started = true; }
      done(null, cipher.update(chunk));
    },
    flush(done) {
      if (!started) this.push(Buffer.concat([ENCRYPTED_MAGIC, salt, iv]));
      this.push(cipher.final());
      done(null, cipher.getAuthTag());
    }
  });
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

const SMALL = 64 * 1024 * 1024;

/** A streaming tar reader that hands each member to `onFile` as it arrives. */
class TarReader extends Writable {
  constructor({ onEntry, maxBytes, maxEntries }) {
    super();
    this.onEntry = onEntry;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.buf = Buffer.alloc(0);
    this.state = "header";
    this.remaining = 0;
    this.padding = 0;
    this.current = null;
    this.pax = null;
    this.longName = null;
    this.count = 0;
    this.total = 0;
    this.ended = false;
  }

  _write(chunk, _enc, done) {
    try {
      this.total += chunk.length;
      if (this.total > this.maxBytes) throw new Error("bundle is larger than the import limit");
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this.drain();
      done();
    } catch (error) {
      done(error);
    }
  }

  drain() {
    for (;;) {
      if (this.ended) return;
      if (this.state === "header") {
        if (this.buf.length < BLOCK) return;
        const h = this.buf.subarray(0, BLOCK);
        this.buf = this.buf.subarray(BLOCK);
        if (h.every((b) => b === 0)) { this.ended = true; return; }
        if (++this.count > this.maxEntries) throw new Error("bundle has too many entries");
        let sum = 0;
        for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
        if (sum !== readOctal(h, 148, 8)) throw new Error("corrupt tar header (checksum)");
        const size = readOctal(h, 124, 12);
        const type = String.fromCharCode(h[156] || 48);
        const prefix = readString(h, 345, 155);
        const raw = prefix ? `${prefix}/${readString(h, 0, 100)}` : readString(h, 0, 100);
        this.current = { type, size, raw, meta: type === "x" || type === "g" || type === "L" ? [] : null };
        this.remaining = size;
        this.padding = (BLOCK - (size % BLOCK)) % BLOCK;
        if (this.current.meta === null) {
          const name = (this.pax?.path ?? this.longName ?? raw).replace(/^\.\//u, "");
          this.pax = null;
          this.longName = null;
          this.current.name = name;
          this.current.sink = this.onEntry({ name, type, size });
        }
        this.state = "body";
        if (size === 0) this.finishEntry();
        continue;
      }
      if (this.state === "body") {
        if (!this.buf.length) return;
        const take = Math.min(this.remaining, this.buf.length);
        const part = this.buf.subarray(0, take);
        this.buf = this.buf.subarray(take);
        this.remaining -= take;
        if (this.current.meta) {
          if (this.current.size > SMALL) throw new Error("oversized tar metadata");
          this.current.meta.push(Buffer.from(part));
        } else this.current.sink?.write(part);
        if (this.remaining === 0) this.finishEntry();
        continue;
      }
      if (this.state === "padding") {
        const take = Math.min(this.padding, this.buf.length);
        this.buf = this.buf.subarray(take);
        this.padding -= take;
        if (this.padding > 0) return;
        this.state = "header";
      }
    }
  }

  finishEntry() {
    const c = this.current;
    if (c.meta) {
      const data = Buffer.concat(c.meta);
      if (c.type === "x") this.pax = parsePax(data);
      if (c.type === "L") this.longName = readString(data, 0, data.length);
    } else c.sink?.end();
    this.state = this.padding ? "padding" : "header";
  }

  _final(done) {
    if (this.state === "body" && this.remaining > 0) done(new Error("truncated bundle"));
    else done();
  }
}

/** A sink that writes a member to disk (or keeps it in memory) while hashing it. */
function fileSink(target, keep) {
  const h = crypto.createHash("sha256");
  let fd = null;
  const parts = keep ? [] : null;
  let size = 0;
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fd = fs.openSync(target, "w", 0o600);
  }
  const sink = {
    write(part) { h.update(part); size += part.length; if (fd !== null) fs.writeSync(fd, part); if (parts) parts.push(Buffer.from(part)); },
    end() { if (fd !== null) fs.closeSync(fd); fd = null; sink.sha256 = h.digest("hex"); sink.size = size; if (parts) sink.data = Buffer.concat(parts); },
    sha256: null, size: 0, data: null
  };
  return sink;
}

async function sourceStream(file, passphrase) {
  const fh = await fs.promises.open(file, "r");
  const { size } = await fh.stat();
  const head = Buffer.alloc(Math.min(size, ENCRYPTED_MAGIC.length + 28));
  await fh.read(head, 0, head.length, 0);
  const encrypted = head.length >= ENCRYPTED_MAGIC.length && head.subarray(0, ENCRYPTED_MAGIC.length).equals(ENCRYPTED_MAGIC);
  if (!encrypted) { await fh.close(); return { encrypted, stages: [fs.createReadStream(file)] }; }
  if (typeof passphrase !== "string" || !passphrase) { await fh.close(); throw new Error("this bundle is encrypted: a passphrase is required"); }
  const m = ENCRYPTED_MAGIC.length;
  if (size < m + 28 + 16) { await fh.close(); throw new Error("truncated encrypted bundle"); }
  const salt = head.subarray(m, m + 16);
  const iv = head.subarray(m + 16, m + 28);
  const tag = Buffer.alloc(16);
  await fh.read(tag, 0, 16, size - 16);
  await fh.close();
  const decipher = crypto.createDecipheriv("aes-256-gcm", crypto.scryptSync(passphrase, salt, 32, SCRYPT), iv);
  decipher.setAAD(ENCRYPTED_MAGIC);
  decipher.setAuthTag(tag);
  const wrapped = new Transform({
    transform(chunk, _e, done) { done(null, decipher.update(chunk)); },
    flush(done) {
      try { done(null, decipher.final()); } catch { done(new Error("wrong passphrase or damaged bundle")); }
    }
  });
  return { encrypted, stages: [fs.createReadStream(file, { start: m + 28, end: size - 17 }), wrapped] };
}

/**
 * Read a bundle file. With stagingDir, every member is written to stagingDir/<member name> and hashed;
 * without it, text members (and manifest.json) are kept in memory and the rest only hashed.
 * Returns { members: Map(name -> { size, sha256, file?, data? }), dirs: [name], rejected, encrypted }.
 */
export async function readBundleFile(file, { passphrase = null, stagingDir = null, keepInMemory = (name) => /\.(?:md|markdown|txt|ya?ml|json|jsonl|canvas|base|csv)$/iu.test(name), maxBytes = STREAM_MAX_BYTES, maxEntries = 500000 } = {}) {
  const { encrypted, stages } = await sourceStream(file, passphrase);
  const members = new Map();
  const dirs = [];
  const rejected = [];
  const reader = new TarReader({
    maxBytes, maxEntries,
    onEntry: ({ name, type, size }) => {
      if (type === "5") {
        const dir = name.replace(/\/+$/u, "");
        const reason = unsafeEntryReason(dir);
        if (reason) rejected.push({ name, reason }); else dirs.push(dir);
        return null;
      }
      if (type !== "0" && type !== "\0" && type !== "7") { rejected.push({ name, reason: `not a regular file (type ${type})` }); return null; }
      const reason = unsafeEntryReason(name);
      if (reason) { rejected.push({ name, reason }); return null; }
      const keep = name === "manifest.json" || !stagingDir && keepInMemory(name) && size <= SMALL;
      const target = stagingDir && name !== "manifest.json" ? path.join(stagingDir, ...name.split("/")) : null;
      const sink = fileSink(target, keep);
      members.set(name, Object.assign(sink, { file: target }));
      return sink;
    }
  });
  try {
    await pipeline(...stages, zlib.createGunzip(), reader);
  } catch (error) {
    // A wrong key yields garbage before GCM's final check, so gunzip usually fails first.
    if (encrypted || /wrong passphrase/u.test(error.message)) throw new Error("wrong passphrase or damaged bundle");
    throw new Error(/incorrect header check|unexpected end|invalid/iu.test(error.message) ? `not a gzip bundle (${error.message})` : error.message);
  }
  return { members, dirs, rejected, encrypted };
}
