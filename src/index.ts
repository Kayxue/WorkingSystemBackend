import { Hono } from "hono";
import { sessionMiddleware } from "hono-sessions";
import { RedisStoreAdapter } from "./Client/RedisSessionStore";
import type { HonoGenericContext } from "./Types/types";
import { argon2Config } from "./config";
import { hash } from "@node-rs/argon2";
import { Glob } from "bun";
import type IRouter from "./Interfaces/IRouter";
import redisClient from "./Client/RedisClient";
import { CronManager } from "./Utils/CronManager";
import { createBunWebSocket } from 'hono/bun';

const app = new Hono<HonoGenericContext>();
const { websocket } = createBunWebSocket();

app.use("*", async (c, next) => {
  const start = Date.now();
  const timestamp = new Date().toISOString();
  const api = c.req.path;

  await next();

  const duration = Date.now() - start;
  const responseTimestamp = new Date().toISOString();
  const response = c.res;
  const status = response.status;
  const logPrefix = `[${responseTimestamp}] Response for API: ${api}, Status: ${status}, Duration: ${duration}ms`;
  const contentType = response.headers.get('Content-Type');
  console.log(logPrefix);
  // if (contentType && (contentType.includes('application/json') || contentType.includes('text/'))) {
  //   try {
  //     const body = await response.clone().json();
  //     console.log(`${logPrefix}, Body:`, JSON.stringify(body));
  //   } catch (e) {
  //       try {
  //           const body = await response.clone().text();
  //           console.log(`${logPrefix}, Body:`, body);
  //       } catch (e2) {
  //           console.log(`${logPrefix} (Could not log body)`);
  //       }
  //   }
  // } else {
  //   console.log(`${logPrefix} (Non-loggable content-type: ${contentType})`);
  // }
});

const store = new RedisStoreAdapter({
  prefix: "hono-session:",
  ttl: 60 * 60 * 24, // 24 小時
  client: redisClient,
});

app.use(
  "*",
  sessionMiddleware({
    store,
    cookieOptions: { maxAge: 60 * 60 * 24, secure: false },
    expireAfterSeconds: 60 * 60 * 24,
    autoExtendExpiration: true,
    encryptionKey: Bun.env.SESSIONSECRET,
  })
);

app.get("/", (c) => {
  return c.text("Hello!");
});

app.get("/hashing/:password", async (c) => {
  const password = c.req.param("password");
  return c.text(await hash(password, argon2Config));
});

// 載入路由
for await (const file of new Glob(`${__dirname}/Routes/**/*.ts`).scan({
  absolute: true,
})) {
  const module = await import(file);
  const { path, router }: IRouter = module.default;
  app.route(path, router);
}

// 初始化系統組件
async function initializeSystem() {
  // 檢查快取連接
  try {
    await redisClient.ping();
  } catch (error) {
    console.error("Redis 快取連接失敗:", error);
  }

  // 初始化 Cron 任務
  try {
    const cronInitialized = await CronManager.initializeCronJobs();

    if (cronInitialized) {
      console.log("Cron 任務初始化完成");
    }
  } catch (error) {
    console.error("Cron 任務初始化過程中發生錯誤:", error);
  }
}

// 在應用啟動時初始化系統
initializeSystem().catch((error) => {
  console.error("系統初始化失敗:", error);
});

export default {
  fetch: app.fetch,
  websocket,
}
