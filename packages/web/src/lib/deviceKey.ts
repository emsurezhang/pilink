/**
 * WebCrypto 设备密钥（SEC-1 / D11）：不可导出的 ECDSA P-256 私钥，IndexedDB 持久化。
 * 不使用 WebAuthn/Passkey（RP ID 不能是 IP 地址）。
 */
const DB_NAME = "pilink";
const STORE = "device-keys";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export interface DeviceKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey; // extractable = false
}

/** 获取或创建设备密钥对。需要安全上下文（HTTPS 或 localhost）。 */
export async function getOrCreateDeviceKey(): Promise<DeviceKeyPair> {
  const existing = await idbGet<DeviceKeyPair>("ecdsa-p256");
  if (existing) return existing;
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false, // 不可导出（SEC-1）
    ["sign", "verify"],
  )) as DeviceKeyPair;
  await idbSet("ecdsa-p256", pair);
  return pair;
}

/** SPKI 公钥 → base64url（配对时上传） */
export async function exportPublicKeyB64(pair: DeviceKeyPair): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  return b64url(new Uint8Array(spki));
}

/** 签名挑战（登录用） */
export async function signChallenge(pair: DeviceKeyPair, challenge: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    new TextEncoder().encode(challenge),
  );
  return b64url(new Uint8Array(sig));
}

export function b64url(buf: Uint8Array): string {
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
