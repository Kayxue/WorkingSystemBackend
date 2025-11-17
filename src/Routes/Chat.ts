import { Hono } from "hono";
import { createBunWebSocket } from 'hono/bun';
import type IRouter from "../Interfaces/IRouter";
import type { HonoGenericContext } from "../Types/types";
import { authenticated } from "../Middleware/authentication";
import type { ServerWebSocket } from 'bun';
import { and, eq, sql, gt, isNull, desc, lt } from "drizzle-orm";
import { workers, employers, conversations, messages, gigs } from "../Schema/DatabaseSchema";
import dbClient from "../Client/DrizzleClient";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { queryGetMessageSchema } from "../Types/zodSchema";
import { FileManager } from "../Client/Cache/Index";
import { requireWorker } from "../Middleware/guards";
import { sign, verify } from 'hono/jwt';
import webSocketManager from "../Utils/WebSocketManager";

const router = new Hono<HonoGenericContext>();
const JWT_SECRET = process.env.JWT_SECRET;

const getUserChannel = (userId: string, role: string) =>
	`user:${role}:${userId}`;

const { upgradeWebSocket } = createBunWebSocket();

async function getUserIdAndRoleFromToken(token: string) {
	try {
		const payload = await verify(token, JWT_SECRET);
		if (!payload.sub || !payload.role) {
			return { id: null, role: null };
		}
		// 檢查 'role' 是否正確
		const role = payload.role as string;
		if (role !== 'worker' && role !== 'employer') {
			return { id: null, role: null };
		}

		return {
			id: payload.sub as string,
			role: role as 'worker' | 'employer',
		};
	} catch (err) {
		// Token 驗證失敗 (過期、簽名錯誤等)
		// console.error('WebSocket Token 驗證失敗:', err);
		return { id: null, role: null };
	}
}

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

router.get('/ws-token', authenticated, async (c) => {
	const user = c.get('user');
	const role = user?.role;

	if (!user?.role || !role) {
		return c.json({ error: 'Not authenticated' }, 401);
	}

	// 產生一個短時效 (例如 20 秒) 的 Token
	// 'sub' (Subject) 儲存用戶 ID
	const token = await sign(
		{
			sub: user.userId,
			role: role,
			exp: Math.floor(Date.now() / 1000) + 20, // 20 秒後過期
		},
		JWT_SECRET
	);

	return c.json({ token });
});

router.get("/ws", upgradeWebSocket((c) => {
	return {
		data: {
			userId: null as string | null,
			role: null as 'worker' | 'employer' | null,
			connectionId: null as string | null,
		},

		onOpen: (event, ws) => {
			console.log(`一個用戶已連線，等待驗證。`);
		},

		onMessage: async (event, ws) => {
			let message;
			const rawWs = ws.raw as ServerWebSocket;
			const userId = ws.raw.data.events.data.userId;
			const userRole = ws.raw.data.events.data.role;

			try {
				message = JSON.parse(event.data as string);
			} catch (error) {
				console.error('無法解析的訊息:', event.data);
				rawWs.close(1003, 'Invalid message format');
				return;
			}

			if (message.type === 'heartbeat' && userId) {
				webSocketManager.handleHeartbeat(rawWs);
				return;
			}

			if (!userId) {
				if (message.type === 'auth') {
					const { id, role } = await getUserIdAndRoleFromToken(message.token);
					if (id && role) {
						// 驗證成功！
						ws.raw.data.events.data.userId = id;
						ws.raw.data.events.data.role = role;

						// 將連線添加到管理器
						webSocketManager.addConnection(rawWs);

						// 訂閱自己的私有頻道 (用於多設備同步和接收訊息)
						rawWs.subscribe(getUserChannel(id, role));

						console.log(`用戶 ${role}:${id} 已驗證並訂閱頻道。`);

						// 回傳成功訊息
						ws.send(JSON.stringify({ type: 'auth_success' }));
					} else {
						// 驗證失敗 (Token 無效或過期)
						rawWs.close(1008, 'Invalid token');
					}
				} else {
					// 在未驗證時發送了 'auth' 以外的訊息
					rawWs.close(1008, 'Authentication required');
				}
				return; // 結束此 'onMessage' 處理
			}

			// --- 2. 處理私訊 ---
			if (message.type === 'private_message') {
				const { recipientId, text, type, replyToId } = message;
				const recipientRole = userRole === 'worker' ? 'employer' : 'worker';
				const { workerID, employerID } = userRole === 'worker' ?
					{ workerID: userId, employerID: recipientId } :
					{ workerID: recipientId, employerID: userId };

				try {
					// 1. 查找或創建對話
					const conversationId = await findOrCreateConversation(workerID, employerID);

					// 2. 儲存訊息
					const [savedMessage] = await dbClient
						.insert(messages)
						.values({
							conversationId: conversationId,
							content: text,
							senderWorkerId: userRole === 'worker' ? userId : null,
							senderEmployerId: userRole === 'employer' ? userId : null,
							replyToId: replyToId || null,
						})
						.returning();

					// 3. 準備推播的 payload
					let payload = {
						type: 'private_message',
						...savedMessage,
					};

					if (savedMessage.replyToId) {
						// 如果有回覆訊息，取得該訊息的內容
						const repliedMessage = await dbClient.query.messages.findFirst({
							where: eq(messages.messagesId, savedMessage.replyToId),
							columns: {
								content: true,
								createdAt: true,
							}
						})
						payload = {
							...payload,
							replySnippet: repliedMessage ? {
								content: repliedMessage.content,
								createdAt: repliedMessage.createdAt,
							} : null
						}
					}

					payload = JSON.stringify(payload);

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
								userRole === 'worker'
									? eq(messages.senderWorkerId, userId)
									: eq(messages.senderEmployerId, userId),
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
					rawWs.publish(getUserChannel(message.recipientId, userRole === 'worker' ? 'employer' : 'worker'), payload);
				} catch (err: any) {
					console.error('撤回失敗:', err.message);
					rawWs.send(JSON.stringify({ type: 'error', text: err.message }));
				}
			}
		},
		onClose: (event, ws) => {
			if (ws.raw.data.events.data.connectionId) {
				webSocketManager.removeConnection(ws.raw as ServerWebSocket);
			}
			// Bun 會自動處理取消訂閱 (unsubscribe)
		},

		onError: (event) => {
			console.error('WebSocket 錯誤:', event);
		},
	}
}));

router.get('/conversations', authenticated, zValidator('query', z.object({
	page: z.coerce.number().int().positive().optional().default(1),
})), async (c) => {
	const user = c.get('user');
	const { page } = c.req.valid('query');
	const requestLimit = 10;
	const requestOffset = requestLimit * (page - 1) || 0;

	// 根據登入角色，動態決定查詢欄位
	const myIdField = user.role === 'worker'
		? { userId: conversations.workerId }
		: { userId: conversations.employerId };

	let myDeletedField: any,
		messagesDeletedField: any,
		myReadTimestampField: any,
		opponentSenderField: any,
		opponentTable: any,
		opponentJoinField: any,
		opponentSelect: any;

	if (user.role === 'worker') {
		myDeletedField = conversations.deletedByWorkerAt;
		messagesDeletedField = messages.deletedByWorker;
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
		messagesDeletedField = messages.deletedByEmployer;
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
					AND msg.${sql.raw(opponentSenderField.name)} IS NOT NULL
          AND msg.${sql.raw(messagesDeletedField.name)} IS NOT TRUE
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
		.orderBy(desc(conversations.lastMessageAt))
		.limit(requestLimit + 1)
		.offset(requestOffset);

	const hasMore = resultConversations.length > requestLimit;
	const paginatedConversations = resultConversations.slice(0, requestLimit);

	// 處理最後一條訊息被撤回的情況
	const processedConversations = await Promise.all(paginatedConversations.map(async (convo) => {
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
				opponent: (user.role === 'employer') ? {
					id: convo.opponent.id,
					name: convo.opponent.firstName + convo.opponent.lastName,
					profilePhoto: photoUrlData,
				} : {
					...convo.opponent,
					profilePhoto: photoUrlData,
				},
			};

		}
		return {
			...convo,
			opponent: (user.role === 'employer') ? {
				id: convo.opponent.id,
				name: convo.opponent.firstName + convo.opponent.lastName,
				profilePhoto: photoUrlData,
			} : {
				...convo.opponent,
				profilePhoto: photoUrlData,
			},
		}
	}));

	return c.json({
		conversations: processedConversations,
		pagination: {
			limit:requestLimit,
			page: page,
			hasMore,
			returned: paginatedConversations.length,
		},
	});
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

		const resultMessages = await dbClient.query.messages.findMany({
			where: and(
				eq(messages.conversationId, conversationId),
				eq(myDeletedFlag, false),
				lt(messages.createdAt, cursor)
			),
			orderBy: [desc(messages.createdAt)],
			limit: limit,

			// 預先載入 "被回覆的訊息" 及其 "發送者"
			with: {
				replyToMessage: true,
				gig: true,
			},
		});

		// --- 處理回傳資料 (已修改) ---
		const processedMessages = resultMessages.map((msg) => {
			// 1. 處理已撤回的訊息
			if (msg.retractedAt) {
				return {
					...msg,
					content: '[訊息已撤回]',
					// ... (清除 senderId 等)
					replyToMessage: null, // 撤回的訊息不顯示回覆
					gig: null, // 撤回的訊息不顯示 gig
				};
			}

			// 2. 處理回覆
			let replySnippet = null;
			if (msg.replyToMessage) {
				const repliedToMsg: {
					messagesId: string;
					content: string;
					retractedAt: Date | null;
					createdAt: Date;
				} = msg.replyToMessage;



				replySnippet = {
					messagesId: repliedToMsg.messagesId,
					// 如果被回覆的訊息也被撤回了，顯示 "[訊息已撤回]"
					content: repliedToMsg.retractedAt ? '[訊息已撤回]' : repliedToMsg.content,
					createdAt: repliedToMsg.createdAt,
				};
			}

			return {
				// ... (msg 的所有欄位, id, content, createdAt, ...)
				messagesId: msg.messagesId,
				conversationId: msg.conversationId,
				gigId: msg.gigId,
				senderWorkerId: msg.senderWorkerId,
				senderEmployerId: msg.senderEmployerId,
				content: msg.content,
				createdAt: msg.createdAt,
				replyToId: msg.replyToId,
				retractedAt: msg.retractedAt,

				// ✨ 新增：回傳簡化版的 "被回覆訊息" 物件
				replySnippet: replySnippet,
				gig: msg.gig, // ✨ 新增：回傳完整的 gig 物件
			};
		});

		return c.json(processedMessages.reverse()); // 反轉以正序顯示
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
	} else {
		// delete all messages in this conversation for me
		await dbClient
			.update(messages)
			.set(
				user.role === 'worker'
					? { deletedByWorker: true }
					: { deletedByEmployer: true }
			)
			.where(
				and(
					eq(messages.conversationId, conversationId),
					// only update messages that are not already deleted by me
					user.role === 'worker'
						? eq(messages.deletedByWorker, false)
						: eq(messages.deletedByEmployer, false)
				)
			);
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

// ----------------------------------------------------
// 6. 發送工作資訊訊息 (Send Gig Info Message)
// POST /api/chat/gig/:employerId/:gigId
// ----------------------------------------------------
router.post('/gig/:employerId/:gigId', authenticated, requireWorker, async (c) => {
	const { employerId, gigId } = c.req.param();
	const user = c.get('user');
	const server = c.get('server');

	// 1. 查詢工作資訊
	const gig = await dbClient.query.gigs.findFirst({
		where: and(
			eq(gigs.gigId, gigId),
			eq(gigs.employerId, employerId)
		),
	});

	if (!gig) {
		return c.json({ error: 'Gig not found' }, 404);
	}

	// 2. 查找或創建對話
	const conversationId = await findOrCreateConversation(user.userId, employerId);

	// 3. 儲存訊息
	const [savedMessage] = await dbClient
		.insert(messages)
		.values({
			conversationId,
			gigId: gigId,
			senderWorkerId: user.userId,
			content: `應聘者正在詢問此工作`,
		})
		.returning();

	// 4. 準備推播的 payload
	const payload = JSON.stringify({
		type: 'gig_message',
		...savedMessage,
		gig: gig, // 將 gig 資訊附加到 payload
	});

	// 5. 推播給接收者和自己
	server.publish(getUserChannel(user.userId, 'worker'), payload);
	server.publish(getUserChannel(employerId, 'employer'), payload);

	return c.json({ success: true, message: savedMessage });
});

// ----------------------------------------------------
// 7. 檢查是否有未讀訊息 (Check for Unread Messages)
// GET /api/chat/unread-status
// ----------------------------------------------------
router.get('/unread-status', authenticated, async (c) => {
	const user = c.get('user');

	const myIdField = user.role === 'worker'
		? conversations.workerId
		: conversations.employerId;

	const myReadTimestampField = user.role === 'worker'
		? conversations.lastReadAtByWorker
		: conversations.lastReadAtByEmployer;

	const myDeletedField = user.role === 'worker'
		? conversations.deletedByWorkerAt
		: conversations.deletedByEmployerAt;

	let unreadCountResult = null;
	if (user.role == 'employer') {
		unreadCountResult = await dbClient
			.select({
				totalUnread: sql<number>`SUM(
          (SELECT COUNT(*)
          FROM ${messages} msg
          WHERE msg.conversation_id = ${conversations.conversationId}
            AND msg.sender_worker_id IS NOT NULL
            AND msg.retracted_at IS NULL
            AND msg.deleted_by_employer IS NOT TRUE
            AND msg.created_at > COALESCE(${myReadTimestampField}, '1970-01-01T00:00:00Z'))
        )::int`,
			})
			.from(conversations)
			.where(
				and(
					eq(myIdField, user.userId),
					isNull(myDeletedField)
				)
			);
	} else if (user.role == 'worker') {
		unreadCountResult = await dbClient
			.select({
				totalUnread: sql<number>`SUM(
          (SELECT COUNT(*)
          FROM ${messages} msg
          WHERE msg.conversation_id = ${conversations.conversationId}
            AND msg.sender_employer_id IS NOT NULL
            AND msg.retracted_at IS NULL
            AND msg.deleted_by_worker IS NOT TRUE
            AND msg.created_at > COALESCE(${myReadTimestampField}, '1970-01-01T00:00:00Z'))
        )::int`,
			})
			.from(conversations)
			.where(
				and(
					eq(myIdField, user.userId),
					isNull(myDeletedField)
				)
			);
	} else {
		return c.text('Invalid role', 400);
	}
	return c.text((unreadCountResult[0]?.totalUnread || 0) > 0 ? 'true' : 'false');
});

export default { path: "/chat", router } as IRouter;