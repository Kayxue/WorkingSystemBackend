import Redis from "ioredis";

// 創建 Redis 客戶端
const redisClient = new Redis({
	maxRetriesPerRequest: 3,
	lazyConnect: true,
	host: Bun.env.REDISCONTAINERNAME ?? "100.118.254.105"
});

// 連接事件處理
redisClient.on("connect", () => {
	console.log("Redis 連接成功");
});

redisClient.on("error", (error) => {
	console.error("Redis 連接錯誤:", error);
});

redisClient.on("close", () => {
	console.log("Redis 連接已關閉");
});

export default redisClient;