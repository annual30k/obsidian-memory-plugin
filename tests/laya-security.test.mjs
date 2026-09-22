import test from "node:test";
import assert from "node:assert/strict";
import { readTrustedServiceFile } from "../lib/memory-router/security.js";

test("readTrustedServiceFile returns null if file is missing or not regular file", () => {
  const mockFs = {
    existsSync: () => false,
    lstatSync: () => ({ isFile: () => false, size: 100 }),
    statSync: () => ({ isFile: () => false }),
    readFileSync: () => ""
  };
  assert.equal(readTrustedServiceFile("/fake/path", { fs: mockFs }), null);

  const mockDirFs = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => false, size: 100 }),
    statSync: () => ({ isFile: () => false }),
    readFileSync: () => ""
  };
  assert.equal(readTrustedServiceFile("/fake/path", { fs: mockDirFs }), null);
});

test("readTrustedServiceFile enforces POSIX user ownership and safe permissions", () => {
  const validJson = JSON.stringify({
    service: "laya-memory-judge",
    endpoint: "http://127.0.0.1:18791",
    api_version: "1",
    token: "secret-token-123"
  });

  // Case 1: UID mismatch
  const fsBadUid = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1001, mode: 0o100600, size: validJson.length }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => validJson
  };
  assert.equal(readTrustedServiceFile("/path/to/service.json", {
    fs: fsBadUid,
    platform: "linux",
    getuid: () => 1000
  }), null);

  // Case 2: Insecure permissions (world-writable 0666 or group-writable 0664)
  const fsBadPerms = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100666, size: validJson.length }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => validJson
  };
  assert.equal(readTrustedServiceFile("/path/to/service.json", {
    fs: fsBadPerms,
    platform: "darwin",
    getuid: () => 1000
  }), null);

  // Case 3: Valid file with 0600 permissions
  const fsValid = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: validJson.length }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => validJson
  };
  const result = readTrustedServiceFile("/path/to/service.json", {
    fs: fsValid,
    platform: "darwin",
    getuid: () => 1000
  });

  assert.notEqual(result, null);
  assert.equal(result.service, "laya-memory-judge");
  assert.equal(result.endpoint, "http://127.0.0.1:18791");
  assert.equal(result.token, "secret-token-123");
});

test("readTrustedServiceFile rejects invalid or oversized service content", () => {
  // Case 1: Oversized file > 16KB
  const fsTooLarge = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: 20000 }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => "{}"
  };
  assert.equal(readTrustedServiceFile("/path", { fs: fsTooLarge, platform: "linux", getuid: () => 1000 }), null);

  // Case 2: Wrong service identity
  const badService = JSON.stringify({
    service: "malicious-service",
    endpoint: "http://127.0.0.1:18791",
    api_version: "1"
  });
  const fsBadService = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: badService.length }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => badService
  };
  assert.equal(readTrustedServiceFile("/path", { fs: fsBadService, platform: "linux", getuid: () => 1000 }), null);

  // Case 3: Non-loopback endpoint in service file
  const badEndpoint = JSON.stringify({
    service: "laya-memory-judge",
    endpoint: "http://example.com:18791",
    api_version: "1"
  });
  const fsBadEndpoint = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: badEndpoint.length }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => badEndpoint
  };
  assert.equal(readTrustedServiceFile("/path", { fs: fsBadEndpoint, platform: "linux", getuid: () => 1000 }), null);
});

test("readTrustedServiceFile strictly rejects token with 0644 permissions or control characters", () => {
  const tokenWith0644 = JSON.stringify({
    service: "laya-memory-judge",
    endpoint: "http://127.0.0.1:18791",
    api_version: "1",
    token: "secret123"
  });
  const fs0644 = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100644, size: tokenWith0644.length }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => tokenWith0644
  };
  assert.equal(readTrustedServiceFile("/path", { fs: fs0644, platform: "linux", getuid: () => 1000 }), null);

  const tokenWithCtrl = JSON.stringify({
    service: "laya-memory-judge",
    endpoint: "http://127.0.0.1:18791",
    api_version: "1",
    token: "secret\r\nBearer malicious"
  });
  const fsCtrl = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: tokenWithCtrl.length }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => tokenWithCtrl
  };
  assert.equal(readTrustedServiceFile("/path", { fs: fsCtrl, platform: "linux", getuid: () => 1000 }), null);
});

test("readTrustedServiceFile enforces Windows user profile containment and blocks sibling bypass", () => {
  const validWinJson = JSON.stringify({
    service: "laya-memory-judge",
    endpoint: "http://127.0.0.1:18791",
    api_version: "1"
  });
  const mockFs = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, size: validWinJson.length }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => validWinJson
  };

  // Valid path inside user home
  const validRes = readTrustedServiceFile("C:\\Users\\bob\\.laya\\service.json", {
    fs: mockFs,
    platform: "win32",
    homedir: () => "C:\\Users\\bob"
  });
  assert.notEqual(validRes, null);

  // Sibling folder bypass: C:\Users\bob-evil\.laya\service.json
  const siblingBypass = readTrustedServiceFile("C:\\Users\\bob-evil\\.laya\\service.json", {
    fs: mockFs,
    platform: "win32",
    homedir: () => "C:\\Users\\bob"
  });
  assert.equal(siblingBypass, null, "Must reject sibling folder prefix bypass on Windows");
});

test("readTrustedServiceFile parses and validates instance_id and pid, rejecting invalid values", () => {
  const createMockFs = (contentObj) => {
    const raw = JSON.stringify(contentObj);
    return {
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: raw.length }),
      statSync: () => ({ isFile: () => true }),
      readFileSync: () => raw
    };
  };

  const valid = readTrustedServiceFile("/path/to/service.json", {
    fs: createMockFs({
      service: "laya-memory-judge",
      endpoint: "http://127.0.0.1:18791",
      token: "secret-tok",
      instance_id: "abc-123_XYZ",
      pid: 4567,
      api_version: "1"
    }),
    platform: "darwin",
    getuid: () => 1000
  });
  assert.notEqual(valid, null);
  assert.equal(valid.instance_id, "abc-123_XYZ");
  assert.equal(valid.instanceId, "abc-123_XYZ");
  assert.equal(valid.pid, 4567);

  // Malformed instance_id (special chars or too long) -> null
  const badInstChar = readTrustedServiceFile("/path/to/service.json", {
    fs: createMockFs({
      service: "laya-memory-judge",
      endpoint: "http://127.0.0.1:18791",
      instance_id: "bad$instance#",
      api_version: "1"
    }),
    platform: "darwin",
    getuid: () => 1000
  });
  assert.equal(badInstChar, null);

  const badInstLong = readTrustedServiceFile("/path/to/service.json", {
    fs: createMockFs({
      service: "laya-memory-judge",
      endpoint: "http://127.0.0.1:18791",
      instance_id: "a".repeat(65),
      api_version: "1"
    }),
    platform: "darwin",
    getuid: () => 1000
  });
  assert.equal(badInstLong, null);

  // Malformed pid (negative, float, or string) -> null
  const badPidNeg = readTrustedServiceFile("/path/to/service.json", {
    fs: createMockFs({
      service: "laya-memory-judge",
      endpoint: "http://127.0.0.1:18791",
      pid: -1,
      api_version: "1"
    }),
    platform: "darwin",
    getuid: () => 1000
  });
  assert.equal(badPidNeg, null);

  const badPidFloat = readTrustedServiceFile("/path/to/service.json", {
    fs: createMockFs({
      service: "laya-memory-judge",
      endpoint: "http://127.0.0.1:18791",
      pid: 12.34,
      api_version: "1"
    }),
    platform: "darwin",
    getuid: () => 1000
  });
  assert.equal(badPidFloat, null);
});
