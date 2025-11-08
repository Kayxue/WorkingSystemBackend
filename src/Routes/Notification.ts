import { Hono } from "hono";
import { authenticated } from "../Middleware/authentication";
import type IRouter from "../Interfaces/IRouter";
import type { HonoGenericContext } from "../Types/types";
import dbClient from "../Client/DrizzleClient";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { notifications } from "../Schema/DatabaseSchema";
import { zValidator } from "@hono/zod-validator";
import { createNotificationSchema, markAsReadSchema, createBatchNotificationSchema, createGroupNotificationSchema } from "../Types/zodSchema";
import NotificationHelper from "../Utils/NotificationHelper";
import { Role } from "../Types/types";

const router = new Hono<HonoGenericContext>();

// 獲取當前用戶的通知列表
router.get("/list", authenticated, async (c) => {
  try {
    const user = c.get("user");
    const limit = c.req.query("limit") || "10";
    const offset = c.req.query("offset") || "0";
    const unreadOnly = c.req.query("unreadOnly") || "false";
    const requestLimit = Number.parseInt(limit);
    const requestOffset = Number.parseInt(offset);
    const isUnreadOnly = unreadOnly === "true";

    // 建構查詢條件
    const whereConditions = [eq(notifications.receiverId, user.workerId || user.employerId || user.adminId)];

    if (isUnreadOnly) {
      whereConditions.push(eq(notifications.isRead, false));
    }

    const whereCondition = whereConditions.length === 1 ? whereConditions[0] : and(...whereConditions);

    // 獲取通知列表
    const notificationList = await dbClient.query.notifications.findMany({
      where: whereCondition,
      orderBy: [desc(notifications.createdAt)],
      columns: {
        notificationId: true,
        title: true,
        message: true,
        type: true,
        isRead: true,
        createdAt: true,
        resourceId: true,
        additionalResourceId: true,
      },
      limit: requestLimit + 1, // 多查一筆來確認是否有更多資料
      offset: requestOffset,
    });

    // 檢查是否有更多資料
    const hasMore = notificationList.length > requestLimit;
    const sliced = hasMore ? notificationList.slice(0, requestLimit) : notificationList;

    return c.json({
      data: {
        notifications: sliced,
        pagination: {
          limit: requestLimit,
          offset: requestOffset,
          hasMore,
          returned: sliced.length,
        },
      },
    }, 200);

  } catch (error) {
    console.error("獲取通知列表失敗:", error);
    return c.json({
      message: "獲取通知列表失敗",
    }, 500);
  }
});

// 獲取是否有未讀通知
router.get("/unread", authenticated, async (c) => {
    const user = c.get("user");
  try {
    const unreadNotification = await dbClient.query.notifications.findFirst({
      where: and(
        eq(notifications.receiverId, user.workerId || user.employerId || user.adminId),
        eq(notifications.isRead, false)
      ),
      columns: {
        notificationId: true,
      },
    });

    return c.json({
      data: {
        hasUnread: !!unreadNotification,
      },
    }, 200);

  } catch (error) {
    console.error("獲取未讀通知狀態失敗:", error);
    return c.json({
      message: "獲取未讀通知狀態失敗",
    }, 500);
  }
});

// 標記通知為已讀
router.put("/mark-as-read", authenticated, zValidator("json", markAsReadSchema), async (c) => {
    const user = c.get("user");
  try {
    const { notificationIds } = c.req.valid("json");
    const isReadParam = c.req.query("isRead");
    const isRead = isReadParam === undefined ? true : isReadParam === "true";

    // 驗證通知是否屬於當前用戶並批量更新
    const result = await dbClient
      .update(notifications)
      .set({
        isRead: isRead,
        readAt: isRead ? sql`now()` : null,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(notifications.receiverId, user.workerId || user.employerId || user.adminId),
        inArray(notifications.notificationId, notificationIds)
      ))
      .returning({ notificationId: notifications.notificationId });

    if (result.length === 0) {
      return c.json({
        message: "找不到有效的通知",
      }, 400);
    }

    return c.json({
      message: `成功標記 ${result.length} 條通知為${isRead ? "已讀" : "未讀"}`,
      data: {
        updatedCount: result.length,
      },
    }, 200);

  } catch (error) {
    console.error("標記通知已讀失敗:", error);
    return c.json({
      message: "標記通知已讀失敗",
    }, 500);
  }
});

// 建立通知 (管理員或系統內部使用)
router.post("/create", authenticated, zValidator("json", createNotificationSchema), async (c) => {
  const body = c.req.valid("json");
  
  try {
    // 建立通知記錄
    const newNotification = await dbClient
      .insert(notifications)
      .values({
        receiverId: body.receiverId,
        title: body.title,
        message: body.message,
        type: body.type,
        resourceId: body.resourceId || null,
      })
      .returning();

    // 如果需要發送推播通知
    if (body.sendPush) {
      const pushSuccess = await NotificationHelper.sendPushNotification(
        body.receiverId,
        body.userRole as Role,
        body.title,
        body.message,
        {
          type: body.type,
          resourceId: body.resourceId || "",
        }
      );
      
      if (!pushSuccess) {
        console.warn(`推播通知發送失敗，用戶ID: ${body.receiverId}`);
      }
    }

    return c.json({
      message: "通知建立成功",
      data: newNotification[0],
    }, 201);

  } catch (error) {
    console.error("建立通知失敗:", error);
    return c.json({
      message: "建立通知失敗",
    }, 500);
  }
});

// 批量建立通知 (管理員或系統內部使用)
router.post("/create-batch", authenticated, zValidator("json", createBatchNotificationSchema), async (c) => {
  try {
    const { receiverIds, title, message, type, resourceId, additionalResourceId } = c.req.valid("json");

    const success = await NotificationHelper.createBatch(receiverIds, { title, message, type, resourceId, additionalResourceId });

    if (success) {
      return c.json({
        message: `成功建立 ${receiverIds.length} 條通知`,
        data: {
          totalCreated: receiverIds.length,
          totalRequested: receiverIds.length,
        },
      }, 201);
    }
    return c.json({
      message: "批量建立通知失敗",
    }, 500);
  } catch (error) {
    console.error("批量建立通知失敗:", error);
    return c.json({
      message: "批量建立通知失敗",
    }, 500);
  }
});

// 發送通知給指定用戶群組 (管理員或系統內部使用)
router.post("/create-group", authenticated, zValidator("json", createGroupNotificationSchema), async (c) => {
  try {
    const { groups, title, message, type, resourceId, additionalResourceId, sendPush } = c.req.valid("json");

    // 建立通知記錄
    const success = await NotificationHelper.notifyUserGroups(groups, title, message, type, resourceId, additionalResourceId);

    if (!success) {
      return c.json({
        message: "群組通知發送失敗",
      }, 500);
    }

    if (sendPush) {
      const pushData = {
        type,
        resourceId: resourceId || "",
        additionalResourceId: additionalResourceId || "",
      };

      const targetRoles: Role[] = [];
      groups.workers && targetRoles.push(Role.WORKER);
      groups.employers && targetRoles.push(Role.EMPLOYER);
      groups.admins && targetRoles.push(Role.ADMIN);

      if (targetRoles.length > 0) {
        await NotificationHelper.sendPushToUserGroup(targetRoles, title, message, pushData);
      }
    }

    return c.json({
      message: "群組通知發送成功",
    }, 201);

  } catch (error) {
    console.error("發送群組通知失敗:", error);
    return c.json({
      message: "發送群組通知失敗",
    }, 500);
  }
});

// 刪除通知
router.delete("/:notificationId", authenticated, async (c) => {
    const user = c.get("user");
  try {
        const notificationId = c.req.param("notificationId");

    // 驗證通知是否屬於當前用戶
    const notification = await dbClient.query.notifications.findFirst({
      where: and(
        eq(notifications.notificationId, notificationId),
        eq(notifications.receiverId, user.workerId || user.employerId || user.adminId)
      ),
    });

    if (!notification) {
      return c.json({
        message: "找不到該通知",
      }, 404);
    }

    await dbClient
      .delete(notifications)
      .where(eq(notifications.notificationId, notificationId));

    return c.json({
      message: "通知刪除成功",
    }, 200);

  } catch (error) {
    console.error("刪除通知失敗:", error);
    return c.json({
      message: "刪除通知失敗",
    }, 500);
  }
});

export default { path: "/notifications", router } as IRouter; 