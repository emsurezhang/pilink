/**
 * Web Push（WS-5，VAPID）。未配置 VAPID 密钥时优雅禁用。
 */
import type { Store } from "../db.js";

interface PushKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let webPush: typeof import("web-push") | null = null;
try {
  webPush = (await import("web-push")) as typeof import("web-push");
} catch {
  webPush = null;
}

export class PushManager {
  private keys: PushKeys | null = null;
  constructor(
    private store: Store,
    vapidSubject?: string,
    vapidPublicKey?: string,
    vapidPrivateKey?: string,
  ) {
    if (vapidSubject && vapidPublicKey && vapidPrivateKey && webPush) {
      this.keys = { publicKey: vapidPublicKey, privateKey: vapidPrivateKey, subject: vapidSubject };
      webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    }
  }

  get enabled(): boolean {
    return this.keys !== null;
  }
  get publicKey(): string | undefined {
    return this.keys?.publicKey;
  }

  saveSubscription(deviceId: string, subscription: { endpoint: string; keys: unknown }): void {
    this.store.savePushSubscription(deviceId, subscription.endpoint, subscription.keys);
  }

  /** 通知所有已授权设备；失败的订阅自动清理。 */
  async notifyAll(payload: { title: string; body: string; url?: string }): Promise<void> {
    if (!this.keys || !webPush) return;
    const subs = this.store.listPushSubscriptions();
    await Promise.allSettled(
      subs.map(async (s) => {
        try {
          await webPush!.sendNotification(
            { endpoint: s.endpoint, keys: JSON.parse(s.keysJson) } as never,
            JSON.stringify(payload),
          );
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.store.db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(s.endpoint);
          }
        }
      }),
    );
  }
}
