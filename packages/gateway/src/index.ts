/**
 * PiLink Gateway 服务入口（设计文档 §10）。
 * Fastify：静态资源 + /api/auth + /api/pair + /ws（客户端）
 * 独立仅回环 HTTP server：/bridge（本机 Bridge 通道）
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { clientMsgSchema, type ClientMsg } from "@pilink/protocol";
import { loadConfig, loadOrCreateSecret, type GatewayConfig } from "./config.js";
import { Store } from "./db.js";
import { AuthManager, RateLimiter } from "./auth/auth.js";
import { LeaseManager } from "./driver/lease.js";
import { BridgeHub } from "./driver/attach.js";
import { Hub, type ClientConn } from "./ws/hub.js";
import type { WsLike } from "./driver/types.js";
import { Ops } from "./ws/ops.js";
import { wsLog, wsConn } from "./log.js";
import { RoleManager } from "./role/manager.js";
import { PushManager } from "./push/push.js";

export const VERSION = "0.1.0";

export interface GatewayContext {
  cfg: GatewayConfig;
  store: Store;
  auth: AuthManager;
  hub: Hub;
  ops: Ops;
  bridgeHub: BridgeHub;
  roles: RoleManager;
  push: PushManager;
  lease: LeaseManager;
  app: FastifyInstance;
  piVersion: string;
}

export async function createGateway(overrides: Partial<GatewayConfig> = {}): Promise<GatewayContext> {
  const cfg = loadConfig(overrides);
  const store = new Store(cfg.dataDir);
  const secret = loadOrCreateSecret(cfg.dataDir);
  const auth = new AuthManager(store, secret, cfg.accessTokenTtlSec, cfg.refreshTokenTtlSec, cfg.maxDevices);
  const lease = new LeaseManager();
  const roles = new RoleManager();
  const push = new PushManager(store, cfg.vapidSubject, cfg.vapidPublicKey, cfg.vapidPrivateKey);

  const app = Fastify({ logger: false, trustProxy: true });
  await app.register(websocket);

  const hub = new Hub(lease, store, {
    ringMaxEvents: cfg.ringMaxEvents,
    ringMaxBytes: cfg.ringMaxBytes,
    audit: (d, w, a, det) => store.audit(d, w, a, det),
    onPushNotify: (p) => void push.notifyAll(p),
  });

  // Bridge 通道：独立仅回环 HTTP server（避免与客户端 WS 混淆）
  const bridgeServer = createServer();
  const bridgeWss = new WebSocketServer({ server: bridgeServer, path: "/bridge" });
  const bridgeHub = new BridgeHub(bridgeWss);
  await new Promise<void>((resolve) => bridgeServer.listen(cfg.bridgePort, cfg.host, resolve));

  const ops = new Ops(cfg, store, hub, lease, bridgeHub, roles, push);
  const piVersion = await detectPiVersion(cfg);

  /* ---------------- HTTP：认证与配对（§11.4） ---------------- */

  const pairLimiter = new RateLimiter(60_000, 10);
  const authLimiter = new RateLimiter(60_000, 20);

  app.post("/api/pair/create", async (req, reply) => {
    if (!isLoopback(req)) return reply.code(403).send({ error: "仅本机可创建配对码" });
    const { code, expiresAt } = auth.createPairCode();
    return { code, expiresAt };
  });

  app.post("/api/pair", async (req, reply) => {
    const ip = req.ip;
    if (!pairLimiter.allow(`pair:${ip}`)) return reply.code(429).send({ error: "请求过于频繁" });
    const body = (req.body ?? {}) as { code?: string; deviceName?: string; devicePubKey?: string };
    if (!body.code || !body.devicePubKey) return reply.code(400).send({ error: "缺少 code 或 devicePubKey" });
    const result = auth.pair(body.code, body.deviceName ?? "", body.devicePubKey, ip);
    if (!result.ok) return reply.code(401).send({ error: result.error });
    return result;
  });

  app.post("/api/auth/challenge", async (req, reply) => {
    if (!authLimiter.allow(`ch:${req.ip}`)) return reply.code(429).send({ error: "请求过于频繁" });
    const { deviceId } = (req.body ?? {}) as { deviceId?: string };
    if (!deviceId) return reply.code(400).send({ error: "缺少 deviceId" });
    const result = auth.createChallenge(deviceId);
    if ("error" in result) return reply.code(401).send({ error: result.error });
    return result;
  });

  app.post("/api/auth/verify", async (req, reply) => {
    if (!authLimiter.allow(`vf:${req.ip}`)) return reply.code(429).send({ error: "请求过于频繁" });
    const { deviceId, signature } = (req.body ?? {}) as { deviceId?: string; signature?: string };
    if (!deviceId || !signature) return reply.code(400).send({ error: "缺少 deviceId 或 signature" });
    const result = auth.verifyChallenge(deviceId, signature);
    if (!result.ok) return reply.code(401).send({ error: result.error });
    return result;
  });

  app.post("/api/auth/refresh", async (req, reply) => {
    const { refreshToken } = (req.body ?? {}) as { refreshToken?: string };
    if (!refreshToken) return reply.code(400).send({ error: "缺少 refreshToken" });
    const result = auth.refreshTokens(refreshToken);
    if (!result.ok) return reply.code(401).send({ error: result.error });
    return result;
  });

  /* ---------------- 静态资源（PWA，NET-2） ---------------- */

  if (existsSync(cfg.webDist)) {
    await app.register(fastifyStatic, { root: cfg.webDist, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api/") || req.raw.url?.startsWith("/ws")) {
        return reply.code(404).send({ error: "not found" });
      }
      reply.type("text/html").send(readFileSync(join(cfg.webDist, "index.html")));
    });
  }

  /* ---------------- WebSocket：/ws（客户端） ---------------- */

  const ctx: GatewayContext = {
    cfg,
    store,
    auth,
    hub,
    ops,
    bridgeHub,
    roles,
    push,
    lease,
    app,
    piVersion,
  };

  app.register(async (scope) => {
    scope.get("/ws", { websocket: true }, (socket, req) => {
      handleClientSocket(ctx, socket as unknown as WsLike, req);
    });
  });

  await app.listen({ port: cfg.port, host: cfg.host });
  console.log(`[pilink] Gateway listening on http://${cfg.host}:${cfg.port}`);
  console.log(`[pilink] Bridge channel on ws://${cfg.host}:${cfg.bridgePort}/bridge`);
  console.log(`[pilink] Data dir: ${cfg.dataDir} · Pi: ${piVersion}`);

  const shutdown = async () => {
    for (const key of [...hub.runtimes.keys()]) await hub.destroyRuntime(key, "gateway shutdown");
    lease.releaseAll();
    await app.close();
    bridgeServer.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  return ctx;
}

function isLoopback(req: FastifyRequest): boolean {
  const ip = req.ip;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}


async function detectPiVersion(cfg: GatewayConfig): Promise<string> {
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(cfg.piPath, ["--version"], { encoding: "utf8", timeout: 5000 });
    return out.trim().split("\n")[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}

function handleClientSocket(ctx: GatewayContext, socket: WsLike, req: FastifyRequest): void {
  let conn: ClientConn | null = null;
  const ip = req.ip;
  wsConn("connect", ip);

  socket.on("message", (data) => {
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      return;
    }
    const parsed = clientMsgSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data as ClientMsg;
    // 收包日志（typing/ping 太密，跳过）
    if (msg.t !== "typing" && msg.t !== "ping") wsLog("in", conn?.deviceName ?? ip, msg);

    if (msg.t === "hello") {
      const { device, error } = ctx.auth.authenticateAccessToken(msg.accessToken);
      if (!device || error) {
        socket.close(4001, error ?? "unauthorized");
        return;
      }
      conn = {
        socket,
        deviceId: device.deviceId,
        deviceName: device.name,
        ip,
        subs: new Map(),
        helloOk: true,
        lastTyping: new Map(),
      };
      ctx.hub.addClient(conn);
      ctx.hub.send(conn, {
        t: "hello_ok",
        serverVersion: VERSION,
        piVersion: ctx.piVersion,
        features: ["host", "attach", "roles", "push", "presence"],
      });
      if (msg.resume) {
        ctx.hub.subscribe(conn, msg.resume.sessionKey, msg.resume.lastSeq, msg.resume.lastEntryId);
      }
      return;
    }
    if (!conn) {
      socket.close(4001, "send hello first");
      return;
    }
    const c: ClientConn = conn;
    switch (msg.t) {
      case "rpc":
        void ctx.hub.handleRpc(c, msg.id, msg.sessionKey, msg.cmd);
        break;
      case "gw":
        void ctx.ops.dispatch(c, msg.id, msg.op);
        break;
      case "ui_response":
        ctx.hub.handleUiResponse(msg.sessionKey, msg.requestId, msg.payload);
        break;
      case "typing":
        ctx.hub.handleTyping(c, msg.sessionKey, msg.typing);
        break;
      case "ping":
        ctx.hub.send(c, { t: "pong", ts: msg.ts });
        break;
    }
  });

  socket.on("close", () => {
    wsConn("close", conn?.deviceName ?? ip, conn ? `subs=${conn.subs.size}` : "unauthenticated");
    if (conn) ctx.hub.removeClient(conn);
  });
  socket.on("error", () => {
    if (conn) ctx.hub.removeClient(conn);
  });
}

/* ---------------- 入口 ---------------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  createGateway().catch((e) => {
    console.error("[pilink] 启动失败：", e);
    process.exit(1);
  });
}
