import type { ServerWebSocket } from "bun";
import redisClient from "../Client/RedisClient";
import { nanoid } from "nanoid";

const CONNECTION_SET_KEY = "websocket_connections";
const USER_MAP_KEY = "websocket_user_map";
const HEARTBEAT_INTERVAL = 30000; // 30 秒
const CLEANUP_INTERVAL = 15000; // 15 秒

type WebSocketData = {
  connectionId: string;
  events: {
    data: {
      userId: string | null;
      role: "worker" | "employer" | null;
    };
  };
};

export class WebSocketManager {
  private static instance: WebSocketManager;
  private connections: Map<string, ServerWebSocket<WebSocketData>>;

  private constructor() {
    this.connections = new Map();
  }

  public static getInstance(): WebSocketManager {
    if (!WebSocketManager.instance) {
      WebSocketManager.instance = new WebSocketManager();
    }
    return WebSocketManager.instance;
  }

  public addConnection(ws: ServerWebSocket<WebSocketData>) {
    const connectionId = nanoid();
    ws.data.events.data.connectionId = connectionId;
    this.connections.set(connectionId, ws);

    const userId = ws.data.events.data.userId;
    const role = ws.data.events.data.role;
    const now = Date.now();

    console.log(`[WebSocketManager] 用戶 ${role}:${userId} (ID: ${connectionId}) 已連線。`);

    // 使用 pipeline 提高效率
    const pipeline = redisClient.pipeline();
    pipeline.zadd(CONNECTION_SET_KEY, now, connectionId);
    if (userId && role) {
      pipeline.hset(USER_MAP_KEY, connectionId, `${role}:${userId}`);
    }
    pipeline.exec();

    // 立即發送一次心跳請求，確保客戶端有回應
    this.requestHeartbeat(ws);
  }

  public removeConnection(ws: ServerWebSocket<WebSocketData>) {
    const connectionId = ws.data.events.data.connectionId;
    if (!connectionId) {
      console.error("[WebSocketManager] 無法移除連線：缺少 connectionId");      
      return;
    }

    const userId = ws.data.events.data.userId;
    const role = ws.data.events.data.role;

    console.log(`[WebSocketManager] 用戶 ${role}:${userId} (ID: ${connectionId}) 已斷線。`);

    this.connections.delete(connectionId);

    // 使用 pipeline 提高效率
    const pipeline = redisClient.pipeline();
    pipeline.zrem(CONNECTION_SET_KEY, connectionId);
    pipeline.hdel(USER_MAP_KEY, connectionId);
    pipeline.exec();
  }

  public handleHeartbeat(ws: ServerWebSocket<WebSocketData>) {
    const connectionId = ws.data.connectionId;
    if (!connectionId) return;

    const now = Date.now();
    redisClient.zadd(CONNECTION_SET_KEY, "XX", now, connectionId);
    // console.log(`[WebSocketManager] 收到來自 ${connectionId} 的心跳。`);
  }

  private requestHeartbeat(ws: ServerWebSocket<WebSocketData>) {
    try {
      ws.send(JSON.stringify({ type: "heartbeat_request" }));
    } catch (error) {
      console.error(`[WebSocketManager] 無法向 ${ws.data.connectionId} 發送心跳請求:`, error);
      this.removeConnection(ws);
    }
  }

  public initializeCleanup() {
    setInterval(async () => {
      const now = Date.now();
      const timeoutThreshold = now - HEARTBEAT_INTERVAL;

      try {
        const expiredConnectionIds = await redisClient.zrangebyscore(
          CONNECTION_SET_KEY,
          0,
          timeoutThreshold
        );

        if (expiredConnectionIds.length > 0) {
          console.log(`[WebSocketManager] 清理 ${expiredConnectionIds.length} 個超時連線...`);
          for (const connectionId of expiredConnectionIds) {
            const ws = this.connections.get(connectionId);
            if (ws) {
              console.log(`[WebSocketManager] 關閉超時連線: ${connectionId}`);
              ws.close(1000, "Heartbeat timeout");
              // onClose 事件會觸發 removeConnection
            } else {
              // 如果 ws 物件不存在 (可能已經斷線但 Redis 未及時清理)，直接從 Redis 移除
              const pipeline = redisClient.pipeline();
              pipeline.zrem(CONNECTION_SET_KEY, connectionId);
              pipeline.hdel(USER_MAP_KEY, connectionId);
              pipeline.exec();
            }
          }
        }
      } catch (error) {
        console.error("[WebSocketManager] 清理任務出錯:", error);
      }
    }, CLEANUP_INTERVAL);

    console.log("[WebSocketManager] 連線清理任務已初始化。");
  }
}

export default WebSocketManager.getInstance();
