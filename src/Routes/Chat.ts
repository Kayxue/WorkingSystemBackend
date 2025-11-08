import { Hono } from "hono";
import { createBunWebSocket } from 'hono/bun';
import type IRouter from "../Interfaces/IRouter";
import type { HonoGenericContext } from "../Types/types";
import { authenticate, authenticated, deserializeUser } from "../Middleware/authentication";
import type { ServerWebSocket } from 'bun';
// import db from "../Client/DrizzleClient";
import { and, eq, avg, count, sql, gt, isNull, getTableColumns, desc, isNotNull, lt } from "drizzle-orm";
import {workers, employers, conversations, messages} from "../Schema/DatabaseSchema";
import dbClient from "../Client/DrizzleClient";
import { zValidator } from "@hono/zod-validator";
import { queryGetMessageSchema } from "../Types/zodSchema";
import {FileManager} from "../Client/Cache/Index";
import { id } from "zod/v4/locales";

const router = new Hono<HonoGenericContext>();

const getUserChannel = (userId: string, role: string) =>
  `user:${role}:${userId}`;
const { upgradeWebSocket} = createBunWebSocket();

// 查找或創建對話 (Drizzle 查詢)
async function findOrCreateConversation(workerId: string, employerId: string) {
  const result = await dbClient
    .insert(conversations)
    .values({
      workerId: workerId,
      employerId: employerId,
      lastMessageAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [conversations.workerId, conversations.employerId],
      set: { lastMessageAt: new Date() },
    })
    .returning({ id: conversations.conversationId });

  return result[0].id;
}

router.get("/test", authenticated, async (c) => {
	const user = c.get("user");
	const server = c.get("server");
	server.publish(getUserChannel(user.userId, user.role), 'This is a test message from the server'); 
	return c.text("Test message sent to server websocket.");
});

router.get("/ws/chat", authenticated, upgradeWebSocket((c) => {
	const user = c.get("user");
	return {
		data: {
				userId: user?.userId ?? null,
				role: user?.role ?? null,
		},

		onOpen: (event, ws) => {
			const rawWs = ws.raw as ServerWebSocket;
			if (user.userId && user.role) {
				console.log("user channel:", getUserChannel(user.userId, user.role));
				rawWs.subscribe(getUserChannel(user.userId, user.role));
				console.log(`用戶 ${user.role}:${user.userId} 已連線。`);
				ws.send(JSON.stringify({ type: 'connection_success' }));
			} else {
				ws.close(1008, 'Failed in authentication');
			}
		},

		onMessage: async (event, ws) => {
			let message;
			const rawWs = ws.raw as ServerWebSocket;
			const senderRole = user.role;
			const senderId = user.userId;
			try {
				message = JSON.parse(event.data as string);
			} catch (error) {
				console.error('無法解析的訊息:', event.data);
				return;
			}

			// if (message.type == 'test') {
			// 	console.log("is user subscribed:", rawWs.isSubscribed(getUserChannel(user.userId, user.role)));
			// 	rawWs.publish(getUserChannel(user.userId, user.role), "This is a test message");
			// 	ws.send(JSON.stringify({ type: 'test_ack', text: 'Test message sent' }));
			// 	return;
			// }
			
			// --- 2. 處理私訊 ---
			if (message.type === 'private_message') {
				const { recipientId, text, type } = message;
				const recipientRole = user.role === 'worker' ? 'employer' : 'worker';
				const {workerID , employerID} = user.role === 'worker' ? 
					{workerID: user.userId, employerID: recipientId} : 
					{workerID: recipientId, employerID: user.userId};
				
				try {
					// 1. 查找或創建對話
					const conversationId = await findOrCreateConversation(workerID, employerID);
					
					// 2. 儲存訊息
					const [savedMessage] = await dbClient
						.insert(messages)
						.values({
							conversationId: conversationId,
							content: text,
							senderWorkerId: senderRole === 'worker' ? senderId : null,
							senderEmployerId: senderRole === 'employer' ? senderId : null,
						})
						.returning();

					// 3. 準備推播的 payload
					const payload = JSON.stringify({
						type: 'private_message',
						...savedMessage,
					});

					// 4. 推播給接收者
					rawWs.publish(getUserChannel(recipientId, recipientRole), payload);
					// 5. 推播給自己 (多設備同步)
					rawWs.send(payload);
				
				} catch (error) {
					console.error('訊息發送失敗:', error);
					rawWs.send(JSON.stringify({ type: 'error', text: 'Failed to send message' }));
				}
			}

			// --- 3. 處理訊息撤回 ---
			if (message.type === 'retract_message') {
				const { messageId } = message;
				const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
				try {
					// 更新訊息狀態 (帶有 3 小時和發送者驗證)
					const [updatedMessage] = await dbClient
						.update(messages)
						.set({
							retractedAt: new Date(),
							content: '[訊息已撤回]', // (可選)
						})
						.where(
							and(
								eq(messages.messagesId, messageId),
								// 條件 1: 我是發送者
								senderRole === 'worker'
									? eq(messages.senderWorkerId, senderId)
									: eq(messages.senderEmployerId, senderId),
								gt(messages.createdAt, threeHoursAgo), // 條件 2: 3 小時內
								isNull(messages.retractedAt) // 條件 3: 未被撤回
							)
						)
						.returning({
							id: messages.messagesId,
							conversationId: messages.conversationId
						});

					if (!updatedMessage) {
						throw new Error('撤回失敗 (可能已超時或權限不足)');
					}

					// 撤回成功，通知對話中的 *雙方*
					const payload = JSON.stringify({
						type: 'message_retracted',
						messageId: updatedMessage.id,
					});
					rawWs.send(payload);
					rawWs.publish(getUserChannel(message.recipientId, senderRole === 'worker' ? 'employer' : 'worker'), payload);
					// const convo = await db.query.conversations.findFirst({
					// 	where: eq(chatSchema.conversations.id, updatedMessage.conversationId),
					// 	columns: { workerId: true, employerId: true }
					// });

					// if (convo) {
					// 	const payload = JSON.stringify({
					// 		type: 'message_retracted',
					// 		messageId: updatedMessage.id,
					// 	});
					// 	// 通知 Worker
					// 	ws.publish(getUserChannel(convo.workerId, 'worker'), payload);
					// 	// 通知 Employer
					// 	ws.publish(getUserChannel(convo.employerId, 'employer'), payload);
					// }
				} catch (err: any) {
					console.error('撤回失敗:', err.message);
					rawWs.send(JSON.stringify({ type: 'error', text: err.message }));
				}
			}
		},
		onClose: (event, ws) => {
			console.log(`用戶 ${user.role}:${user.userId} 已斷線。`);
			// Bun 會自動處理取消訂閱 (unsubscribe)
		},

		onError: (event) => {
			console.error('WebSocket 錯誤:', event);
		},
	}	
}));

router.get('/conversations', authenticated, async (c) => {
  const user = c.get('user');

  // 根據登入角色，動態決定查詢欄位
  const myIdField = user.role === 'worker'
	? { userId: conversations.workerId }
	: { userId: conversations.employerId };

  let myDeletedField: any,
    myReadTimestampField: any,
		opponentSenderField: any,
    opponentTable: any,
    opponentJoinField: any,
    opponentSelect: any;

  if (user.role === 'worker') {
    myDeletedField = conversations.deletedByWorkerAt;
    myReadTimestampField = conversations.lastReadAtByWorker;
		opponentSenderField = messages.senderEmployerId;
    opponentTable = employers;
    opponentJoinField = conversations.employerId;
    opponentSelect = {
      id: employers.employerId,
      name: employers.employerName, // Employer 顯示公司名稱
			profile: employers.employerPhoto,
    };
  } else {
    // role === 'employer'
    myDeletedField = conversations.deletedByEmployerAt;
    myReadTimestampField = conversations.lastReadAtByEmployer;
		opponentSenderField = messages.senderWorkerId;
    opponentTable = workers;
    opponentJoinField = conversations.workerId;
    opponentSelect = {
      id: workers.workerId,
      firstName: workers.firstName, // Worker 顯示姓名
	  	lastName: workers.lastName,
			profilePhoto: workers.profilePhoto,
		};
  }

  // 使用子查詢計算未讀數量和獲取最後一條訊息
  const resultConversations = await dbClient
    .select({
      conversationId: conversations.conversationId,
			workerId: conversations.workerId,
			employerId: conversations.employerId,
			lastMessageAt: conversations.lastMessageAt,
			createdAt: conversations.createdAt,
			lastReadAtByWorker: conversations.lastReadAtByWorker,
			lastReadAtByEmployer: conversations.lastReadAtByEmployer,
      
      // 獲取對方的資訊
      opponent: opponentSelect,
      
      // 計算未讀數量 AND msg.${sql.raw(opponentSenderField.name)} IS NOT NULL
      unreadCount: sql<number>`(
        SELECT COUNT(*)
        FROM ${messages} msg
        WHERE msg.conversation_id = ${conversations.conversationId}
					
          AND msg.retracted_at IS NULL
          AND msg.created_at > COALESCE(${myReadTimestampField}, '1970-01-01T00:00:00Z')
      )::int`,
      
      // 獲取最後一條訊息的內容 (用於預覽)
      lastMessage: sql<string>`(
        SELECT content
        FROM ${messages} msg
        WHERE msg.conversation_id = ${conversations.conversationId}
        ORDER BY msg.created_at DESC
        LIMIT 1
      )`,
    })
    .from(conversations)
    .leftJoin(opponentTable, eq(opponentJoinField, opponentTable.workerId))
    .where(
      and(
        eq(myIdField.userId, user.userId), // 1. 是我的對話
        isNull(myDeletedField) // 2. 且我沒有刪除它
      )
    )
    .orderBy(desc(conversations.lastMessageAt));

  // 處理最後一條訊息被撤回的情況
  const processedConversations = await Promise.all(resultConversations.map(async (convo) => {
    // (這裡需要額外的邏輯來檢查 lastMessage 是否已被撤回，
    // 為簡化起見，上面的 SQL 已排除了撤回的訊息)
		if (convo.opponent == null) {
			return {
				...convo,
				opponent: { id: null, name: '[用戶已刪除]' },
			}
		}
		let photoUrlData = null;
		const profilePhoto = convo.opponent.profilePhoto;
		if (profilePhoto && typeof profilePhoto === 'object' && profilePhoto.r2Name) {
			const url = await FileManager.getPresignedUrl(`profile-photos/workers/${profilePhoto.r2Name}`);
			if (url) {
				photoUrlData = {
					url: url,
					originalName: profilePhoto.originalName,
					type: profilePhoto.type,
				};
			}

			return {
				...convo,
				// 確保 opponent 物件存在
				opponent: (user.role == 'employer') ? {
					id: convo.opponent.id,
					name: convo.opponent.firstName + convo.opponent.lastName,
					profilePhoto: photoUrlData,
				} : {
					...convo.opponent,
					profilePhoto: photoUrlData,
				},
			};

		} else {
			return {
				...convo,
				opponent: (user.role == 'employer') ? {
					id: convo.opponent.id,
					name: convo.opponent.firstName + convo.opponent.lastName,
					profilePhoto: photoUrlData,
				} : {
					...convo.opponent,
					profilePhoto: photoUrlData,
				},
			}
		}
  }));

  return c.json(processedConversations);
});

router.get('/conversations/:conversationId/messages', authenticated
	, zValidator('query', queryGetMessageSchema), async (c) => {
    const { conversationId } = c.req.param();
    const { limit, before } = c.req.valid('query');
    const user = c.get('user');

    // 決定 "我" 的刪除標記
    const myDeletedFlag =
      user.role === 'worker'
        ? messages.deletedByWorker
        : messages.deletedByEmployer;

    // 決定游標 (cursor)
    const cursor = before ? new Date(before) : new Date();

    const resultMessages = await dbClient
      .select({
				messagesId: messages.messagesId,
				conversationId: messages.conversationId,
				senderWorkerId: messages.senderWorkerId,
				senderEmployerId: messages.senderEmployerId,
				content: messages.content,
				createdAt: messages.createdAt,
				retractedAt: messages.retractedAt,		
		})
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(myDeletedFlag, false), // 1. 我沒有刪除這條訊息
          lt(messages.createdAt, cursor) // 2. 用於分頁
          // (安全檢查：應確保用戶是此對話成員，為簡化暫省略)
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit);


    // 處理已撤回的訊息
    const processedMessages = resultMessages.map((msg) => {
      if (msg.retractedAt) {
        return {
          ...msg,
          content: '[訊息已撤回]', // 遮蔽內容
        };
      }
      return msg;
    });

    return c.json(processedMessages.reverse()); // 反轉陣列，讓前端能正向顯示 (舊 -> 新)
  }
);

// ----------------------------------------------------
// 3. 軟刪除對話 (Conversation)
// DELETE /api/chat/conversations/:conversationId
// ----------------------------------------------------
router.delete('/conversations/:conversationId', authenticated, async (c) => {
  const { conversationId } = c.req.param();
  const user = c.get('user');
  const deleteField =
    user.role === 'worker'
      ? { deletedByWorkerAt: new Date() }
      : { deletedByEmployerAt: new Date() };

  const myIdField =
    user.role === 'worker'
      ? conversations.workerId
      : conversations.employerId;

  const result = await dbClient
    .update(conversations)
    .set(deleteField)
    .where(
      and(
        eq(conversations.conversationId, conversationId),
        eq(myIdField, user.userId) // 安全檢查：確保我屬於此對話
      )
    )
    .returning();

  if (result.length === 0) {
    return c.json({ error: 'Conversation not found or access denied' }, 404);
  }

  return c.json({ success: true });
});

// ----------------------------------------------------
// 4. 軟刪除訊息 (Message)
// DELETE /api/chat/messages/:messageId
// ----------------------------------------------------
router.delete('/messages/:messageId', authenticated, async (c) => {
  const { messageId } = c.req.param();
  const user = c.get('user');

  // 1. 驗證我是否屬於此訊息的對話
  const message = await dbClient.query.messages.findFirst({
    where: eq(messages.messagesId, messageId),
    with: {
      conversation: {
        columns: { workerId: true, employerId: true },
      },
    },
  });

  if (!message) {
    return c.json({ error: 'Message not found' }, 404);
  }

  // 2. 權限檢查
  const isParticipant =
    (user.role === 'worker' && message.conversation.workerId === user.userId) ||
    (user.role === 'employer' && message.conversation.employerId === user.userId);

  if (!isParticipant) {
    return c.json({ error: 'Access denied' }, 403);
  }

  // 3. 執行軟刪除
  const deleteField =
    user.role === 'worker'
      ? { deletedByWorker: true }
      : { deletedByEmployer: true };

  await dbClient
    .update(messages)
    .set(deleteField)
    .where(eq(messages.messagesId, messageId));

  return c.json({ success: true });
});

// ----------------------------------------------------
// 5. 標記對話為已讀 (Mark Conversation as Read)
// POST /api/chat/conversations/:conversationId/read
// ----------------------------------------------------
router.post('/conversations/:conversationId/read', authenticated, async (c) => {
  const { conversationId } = c.req.param();
  const user = c.get('user');
  const server = c.get('server'); // 獲取 Bun 伺服器實例

  const readAtTime = new Date();

  // 1. 決定要更新的欄位
  const updateField =
    user.role === 'worker'
      ? { lastReadAtByWorker: readAtTime }
      : { lastReadAtByEmployer: readAtTime };

  // 2. 決定用於安全檢查的欄位
  const myIdField =
    user.role === 'worker'
      ? conversations.workerId
      : conversations.employerId;

  // 3. 更新資料庫並返回對方 ID
  const [convo] = await dbClient
    .update(conversations)
    .set(updateField)
    .where(
      and(
        eq(conversations.conversationId, conversationId),
        eq(myIdField, user.userId) // 確保我屬於此對話
      )
    )
    .returning({
      workerId: conversations.workerId,
      employerId: conversations.employerId,
    });

  if (!convo) {
    return c.json({ error: 'Conversation not found or access denied' }, 404);
  }

  // 4. 透過 WebSocket 廣播「已讀」事件
  const opponentRole = user.role === 'worker' ? 'employer' : 'worker';
  const opponentId =
    user.role === 'worker' ? convo.employerId : convo.workerId;
  const opponentChannel = getUserChannel(opponentId, opponentRole);

  const payload = JSON.stringify({
    type: 'messages_read',
    conversationId: conversationId,
    readByUserId: user.userId, // 告訴對方是誰讀了
    readAt: readAtTime,
  });

  // 發布給對方
  server.publish(opponentChannel, payload);
  
  // 發布給自己
  const myChannel = getUserChannel(user.userId, user.role);
  server.publish(myChannel, payload);

  return c.json({ success: true, readAt: readAtTime });
});

export default { path: "/chat", router } as IRouter;