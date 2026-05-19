/**
 * Standalone QR login for acp-bridge-wechat (wraps vendored login-qr).
 */

import {
  displayQRCode,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
  DEFAULT_ILINK_BOT_TYPE,
} from "./login-qr.js";
import { loadToken, saveToken, type TokenData } from "./token.js";

export { loadToken, saveToken, type TokenData } from "./token.js";

export async function login(params: {
  baseUrl: string;
  botType?: string;
  storageDir: string;
  log: (msg: string) => void;
  renderQrUrl?: (url: string) => void;
  verbose?: boolean;
}): Promise<TokenData> {
  const { baseUrl, storageDir, log, renderQrUrl, verbose } = params;
  const botType = params.botType ?? DEFAULT_ILINK_BOT_TYPE;
  const existing = loadToken(storageDir);

  log("Starting WeChat QR login...");

  const start = await startWeixinLoginWithQr({
    apiBaseUrl: baseUrl,
    botType,
    storageDir,
    verbose,
    accountId: "default",
  });

  if (!start.qrcodeUrl) {
    throw new Error(start.message || "Failed to start QR login");
  }

  log("Please scan the QR code with WeChat:");
  if (renderQrUrl) {
    renderQrUrl(start.qrcodeUrl);
  } else {
    await displayQRCode(start.qrcodeUrl);
  }

  const wait = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: baseUrl,
    botType,
    storageDir,
    verbose,
  });

  if (wait.alreadyConnected) {
    if (existing) {
      log("Already connected — using saved token.");
      return existing;
    }
    throw new Error(wait.message || "Already connected but no saved token found; run without --login first");
  }

  if (!wait.connected || !wait.botToken || !wait.accountId) {
    throw new Error(wait.message || "Login failed");
  }

  const tokenData: TokenData = {
    token: wait.botToken,
    baseUrl: wait.baseUrl || baseUrl,
    accountId: wait.accountId,
    userId: wait.userId ?? "",
    savedAt: new Date().toISOString(),
  };

  saveToken(storageDir, tokenData);
  log(`Login successful! Bot ID: ${tokenData.accountId}`);
  log(`Token saved to ${storageDir}/token.json`);
  return tokenData;
}
