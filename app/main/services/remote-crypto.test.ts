import { describe, expect, it } from "vitest";
import {
  computeRemoteSecret,
  decryptRemoteMessage,
  deriveRemoteKeys,
  encryptRemoteMessage,
  generateRemoteKeyPair,
  pairingCode,
} from "./remote-crypto";

describe("remote terminal crypto", () => {
  it("双方派生相同密钥并按方向加解密", () => {
    const pc = generateRemoteKeyPair();
    const phone = generateRemoteKeyPair();
    const pcKeys = deriveRemoteKeys(computeRemoteSecret(pc.privateKey, phone.publicKey));
    const phoneKeys = deriveRemoteKeys(computeRemoteSecret(phone.privateKey, pc.publicKey));
    expect(pcKeys.auth.equals(phoneKeys.auth)).toBe(true);
    expect(pairingCode(pcKeys.auth, "token")).toBe(pairingCode(phoneKeys.auth, "token"));

    const encrypted = encryptRemoteMessage(phoneKeys.clientToServer, "c2s", "conn", 1, "hello");
    expect(decryptRemoteMessage(pcKeys.clientToServer, "c2s", "conn", encrypted)).toBe("hello");
  });

  it("篡改方向、连接或序号后无法解密", () => {
    const pc = generateRemoteKeyPair();
    const phone = generateRemoteKeyPair();
    const keys = deriveRemoteKeys(computeRemoteSecret(pc.privateKey, phone.publicKey));
    const encrypted = encryptRemoteMessage(keys.serverToClient, "s2c", "conn", 7, "payload");

    expect(decryptRemoteMessage(keys.serverToClient, "c2s", "conn", encrypted)).toBeNull();
    expect(decryptRemoteMessage(keys.serverToClient, "s2c", "other", encrypted)).toBeNull();
    expect(decryptRemoteMessage(keys.serverToClient, "s2c", "conn", { ...encrypted, sequence: 8 })).toBeNull();
  });
});

