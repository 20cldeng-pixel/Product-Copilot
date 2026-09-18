import * as crypto from "node:crypto";

const CURVE = "prime256v1";
const KEY_SIZE = 32;

export interface RemoteKeyPair {
  privateKey: crypto.ECDH;
  publicKey: string;
}

export interface RemoteSessionKeys {
  auth: Buffer;
  clientToServer: Buffer;
  serverToClient: Buffer;
}

export interface EncryptedRemoteMessage {
  sequence: number;
  iv: string;
  tag: string;
  data: string;
}

export function generateRemoteKeyPair(): RemoteKeyPair {
  const privateKey = crypto.createECDH(CURVE);
  privateKey.generateKeys();
  return { privateKey, publicKey: privateKey.getPublicKey().toString("base64") };
}

export function computeRemoteSecret(privateKey: crypto.ECDH, peerPublicKey: string): Buffer {
  return privateKey.computeSecret(Buffer.from(peerPublicKey, "base64"));
}

export function deriveRemoteKeys(sharedSecret: Buffer): RemoteSessionKeys {
  const derive = (info: string): Buffer => Buffer.from(crypto.hkdfSync(
    "sha256",
    sharedSecret,
    Buffer.from("easymint-remote-terminal-v1", "utf8"),
    Buffer.from(info, "utf8"),
    KEY_SIZE,
  ));
  return {
    auth: derive("authentication"),
    clientToServer: derive("client-to-server"),
    serverToClient: derive("server-to-client"),
  };
}

export function remoteProof(key: Buffer, value: string): string {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest("base64");
}

function aad(direction: "c2s" | "s2c", connectionId: string, sequence: number): Buffer {
  return Buffer.from(`1:${direction}:${connectionId}:${sequence}`, "utf8");
}

export function encryptRemoteMessage(
  key: Buffer,
  direction: "c2s" | "s2c",
  connectionId: string,
  sequence: number,
  plaintext: string,
): EncryptedRemoteMessage {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(direction, connectionId, sequence));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    sequence,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export function decryptRemoteMessage(
  key: Buffer,
  direction: "c2s" | "s2c",
  connectionId: string,
  message: EncryptedRemoteMessage,
): string | null {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(message.iv, "base64"));
    decipher.setAAD(aad(direction, connectionId, message.sequence));
    decipher.setAuthTag(Buffer.from(message.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(message.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export function pairingCode(key: Buffer, token: string): string {
  const digest = crypto.createHmac("sha256", key).update(`pair:${token}`, "utf8").digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

