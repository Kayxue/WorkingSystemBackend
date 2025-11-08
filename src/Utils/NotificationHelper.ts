import dbClient from "../Client/DrizzleClient.ts";
import { notifications, workers, employers, admins } from "../Schema/DatabaseSchema.ts";
import FCMClient from "../Client/FCMClient.ts";
import { eq } from "drizzle-orm";
import type { FCMTokenData } from "../Client/FCMClient";
import { Role } from "../Types/types";

// 通知類型定義
export type NotificationType = "application" | "rating" | "account" | "system";

interface NotificationParams {
  receiverId: string;
  title: string;
  message: string;
  type: NotificationType;
  resourceId?: string;
  additionalResourceId?: string;
}

interface NotificationParamsWithRole extends NotificationParams {
  userRole: Role;
}

class NotificationHelper {

  /**
   * 發送 FCM 推播通知
   */
  static async sendPushNotification(
    userId: string,
    userRole: Role,
    title: string,
    message: string,
    data?: Record<string, string>
  ): Promise<boolean> {
    try {
      let userData: any = null;

      if (userRole === Role.WORKER) {
        userData = await dbClient.query.workers.findFirst({
          where: eq(workers.workerId, userId),
          columns: { fcmTokens: true },
        });
      } else if (userRole === Role.EMPLOYER) {
        userData = await dbClient.query.employers.findFirst({
          where: eq(employers.employerId, userId),
          columns: { fcmTokens: true },
        });
      } else if (userRole === Role.ADMIN) {
        userData = await dbClient.query.admins.findFirst({
          where: eq(admins.adminId, userId),
          columns: { fcmTokens: true },
        });
      }

      if (!userData) {
        return false;
      }

      let tokens: FCMTokenData[] = [];

      if (userData.fcmTokens) {
        tokens = typeof userData.fcmTokens === 'string' 
          ? JSON.parse(userData.fcmTokens) 
          : userData.fcmTokens;
      }

      const tokenStrings = tokens.map(tokenData => tokenData.token);
      
      if (tokenStrings.length === 0) {
        console.log(`用戶 ${userId} 沒有可用的 FCM tokens`);
        return true;
      }

      const notification = {
        title,
        body: message,
      };

      if (tokenStrings.length === 1) {
        return await FCMClient.sendToToken(tokenStrings[0], notification, data);
      } else {
        const result = await FCMClient.sendToMultipleTokens(tokenStrings, notification, data);
        return result.successCount > 0;
      }
    } catch (error) {
      console.error("發送推播通知失敗:", error);
      return false;
    }
  }

  /**
   * 發送推播給指定用戶群組
   */
  static async sendPushToUserGroup(
    userRoles: Role | Role[],
    title: string,
    message: string,
    data?: Record<string, string>
  ): Promise<void> {
    try {
      const allTokens: string[] = [];
      const roles = Array.isArray(userRoles) ? userRoles : [userRoles];
      const queryPromises = [];
      
      if (roles.includes(Role.WORKER)) {
        queryPromises.push(
          dbClient.query.workers.findMany({
            columns: { fcmTokens: true },
          })
        );
      }
      
      if (roles.includes(Role.EMPLOYER)) {
        queryPromises.push(
          dbClient.query.employers.findMany({
            columns: { fcmTokens: true },
          })
        );
      }
      
      if (roles.includes(Role.ADMIN)) {
        queryPromises.push(
          dbClient.query.admins.findMany({
            columns: { fcmTokens: true },
          })
        );
      }

      if (queryPromises.length === 0) {
        console.log('沒有指定有效的用戶角色');
        return;
      }

      const results = await Promise.all(queryPromises);

      for (const userGroup of results) {
        for (const user of userGroup) {
          if (user.fcmTokens) {
            const tokens: FCMTokenData[] = typeof user.fcmTokens === 'string' 
              ? JSON.parse(user.fcmTokens) 
              : user.fcmTokens;
            const tokenStrings = tokens.map(tokenData => tokenData.token);
            allTokens.push(...tokenStrings);
          }
        }
      }

      if (allTokens.length === 0) {
        console.log(`沒有可用的 FCM tokens 用於 ${roles.join(', ')} 群組推播`);
        return;
      }

      const notification = {
        title,
        body: message,
      };

      // 分批發送以避免超過 FCM 限制 (每次最多 500 個 tokens)
      const FCM_BATCH_SIZE = 500;

      for (let i = 0; i < allTokens.length; i += FCM_BATCH_SIZE) {
        const tokenBatch = allTokens.slice(i, i + FCM_BATCH_SIZE);
        await FCMClient.sendToMultipleTokens(tokenBatch, notification, data);
      }
      
      console.log(`成功發送推播給 ${roles.join(', ')} 群組，共 ${allTokens.length} 個設備`);
    } catch (error) {
      const roles = Array.isArray(userRoles) ? userRoles : [userRoles];
      console.error(`發送推播給 ${roles.join(', ')} 群組失敗:`, error);
    }
  }

  /**
   * 建立單一通知
   */
  static async create(params: NotificationParamsWithRole | NotificationParams, sendPush: boolean): Promise<boolean> {
    try {
      if ('userRole' in params) {
        const { userRole, ...notificationData } = params;
        await dbClient.insert(notifications).values(notificationData);

        if (sendPush) {
          await this.sendPushNotification(
            params.receiverId,
            userRole,
            params.title,
            params.message,
            {
              type: params.type,
              resourceId: params.resourceId || "",
              additionalResourceId: params.additionalResourceId || "",
            }
          );
        }
      } else {
        await dbClient.insert(notifications).values(params);
      }

      return true;
    } catch (error) {
      console.error("建立通知失敗:", error);
      return false;
    }
  }

  /**
   * 批量建立通知
   */
  static async createBatch(
    receiverIds: string[], 
    params: Omit<NotificationParams, 'receiverId'>, 
  ): Promise<boolean> {
    try {
      if (receiverIds.length === 0) return true;
      
      const BATCH_SIZE = 1000;
      
      // 序列處理批次
      for (let i = 0; i < receiverIds.length; i += BATCH_SIZE) {
        const batch = receiverIds.slice(i, i + BATCH_SIZE);
        const data = batch.map(receiverId => ({ receiverId, ...params }));
        await dbClient.insert(notifications).values(data);
        
        // 如果還有更多批次，稍微等待避免壓力過大
        if (i + BATCH_SIZE < receiverIds.length) {
          await new Promise(resolve => setTimeout(resolve, 10)); // 10ms 延遲
        }
      }
      
      return true;
    } catch (error) {
      console.error("批量建立通知失敗:", error);
      return false;
    }
  }

  // ========== 具體通知方法 ==========
  static async notifyApplicationReceived(
    employerId: string,
    userRole: Role,
    workerName: string,
    gigTitle: string,
    resourceId: string,
    additionalResourceId?: string, // applicationId
  ) {
    return this.create({
      receiverId: employerId,
      userRole,
      title: "收到新的工作申請",
      message: `${workerName} 申請了您的工作「${gigTitle}」，請及時處理。`,
      type: "application",
      resourceId,
      additionalResourceId,
    }, true);
  }

  static async notifyApplicationApproved(
    workerId: string,
    userRole: Role,
    gigTitle: string,
    employerName: string,
    resourceId: string,
    additionalResourceId?: string, // applicationId
  ) {
    return this.create({
      receiverId: workerId,
      userRole,
      title: "工作申請已通過",
      message: `恭喜！您申請的工作「${gigTitle}」已被 ${employerName} 核准。`,
      type: "application",
      resourceId,
      additionalResourceId,
    }, true);
  }

  static async notifyApplicationRejected(
    workerId: string,
    userRole: Role,
    gigTitle: string,
    employerName: string,
    resourceId: string,
    additionalResourceId?: string, // applicationId
  ) {
    const message = `很抱歉，您申請的工作「${gigTitle}」被 ${employerName} 拒絕。`;

    return this.create({
      receiverId: workerId,
      userRole,
      title: "工作申請未通過",
      message,
      type: "application",
      resourceId,
      additionalResourceId,
    }, true);
  }

  /**
   * 通知打工者：企業已接受申請，請確認是否接受工作
   */
  static async notifyWorkerPendingConfirmation(
    workerId: string,
    userRole: Role,
    gigTitle: string,
    employerName: string,
    resourceId: string,
    additionalResourceId?: string, // applicationId
  ) {
    return this.create({
      receiverId: workerId,
      userRole,
      title: "請確認是否接受工作",
      message: `${employerName} 已接受您對「${gigTitle}」的申請，請確認是否接受此工作。`,
      type: "application",
      resourceId,
      additionalResourceId,
    }, true);
  }

  /**
   * 通知企業：打工者已確認接受工作
   */
  static async notifyEmployerWorkerConfirmed(
    employerId: string,
    userRole: Role,
    workerName: string,
    gigTitle: string,
    resourceId: string,
    additionalResourceId?: string, // applicationId
  ) {
    return this.create({
      receiverId: employerId,
      userRole,
      title: "打工者已確認接受",
      message: `${workerName} 已確認接受工作「${gigTitle}」。`,
      type: "application",
      resourceId,
      additionalResourceId,
    }, true);
  }

  /**
   * 通知企業：打工者拒絕接受工作
   */
  static async notifyEmployerWorkerDeclined(
    employerId: string,
    userRole: Role,
    workerName: string,
    gigTitle: string,
    resourceId: string,
    additionalResourceId?: string, // applicationId
  ) {
    return this.create({
      receiverId: employerId,
      userRole,
      title: "打工者拒絕接受",
      message: `${workerName} 拒絕接受工作「${gigTitle}」。`,
      type: "application",
      resourceId,
      additionalResourceId,
    }, true);
  }

  /**
   * 通知打工者：申請因時間衝突被系統自動取消
   */
  static async notifyWorkerSystemCancelled(
    workerId: string,
    userRole: Role,
    gigTitle: string,
    reason: string,
    resourceId: string,
    additionalResourceId?: string, // applicationId
  ) {
    return this.create({
      receiverId: workerId,
      userRole,
      title: "申請已被系統取消",
      message: `您的工作「${gigTitle}」申請已被系統取消。原因：${reason}`,
      type: "system",
      resourceId,
      additionalResourceId,
    }, true);
  }

  /**
   * 通知企業：打工者的申請因時間衝突被系統自動取消
   */
  static async notifyEmployerApplicationSystemCancelled(
    employerId: string,
    userRole: Role,
    workerName: string,
    gigTitle: string,
    reason: string,
    resourceId: string,
    additionalResourceId?: string, // applicationId
  ) {
    return this.create({
      receiverId: employerId,
      userRole,
      title: "申請已被系統取消",
      message: `${workerName} 的工作「${gigTitle}」申請已被系統取消。原因：${reason}`,
      type: "system",
      resourceId,
      additionalResourceId,
    }, true);
  }

  static async notifyRatingReceived(
    receiverId: string,
    userRole: Role,
    raterName: string,
    ratingValue: number,
    resourceId: string,
    additionalResourceId?: string, // gigId
  ) {
    return this.create({
      receiverId,
      userRole,
      title: "收到新評價",
      message: `${raterName} 給了您 ${ratingValue} 星評價，快去查看吧！`,
      type: "rating",
      resourceId,
      additionalResourceId,
    }, true);
  }

  static async notifyAccountApproved(userId: string, userRole: Role, accountName: string) {
    return this.create({
      receiverId: userId,
      userRole,
      title: "帳戶審核通過",
      message: `恭喜！您的帳戶「${accountName}」已通過審核，現在可以開始使用所有功能。`,
      type: "account",
      resourceId: userId,
    }, true);
  }

  static async notifyAccountRejected(userId: string, userRole: Role, accountName: string, reason: string) {
    const message = `很抱歉，您的帳戶「${accountName}」審核未通過，原因：${reason}。`;

    return this.create({
      receiverId: userId,
      userRole,
      title: "帳戶審核未通過",
      message,
      type: "account",
      resourceId: userId,
    }, true);
  }

  static async notifyUserWelcome(userId: string, userName: string, userType: "worker" | "employer") {
    const title = userType === "worker" ? "歡迎加入打工平台！" : "歡迎加入商家平台！";
    const message = userType === "worker"
      ? `${userName}，歡迎您加入我們的打工平台！您現在可以開始瀏覽和申請工作機會。`
      : `${userName}，歡迎您加入我們的平台！您的帳戶正在審核中，審核通過後即可開始發佈工作。`;

    return this.create({
      receiverId: userId,
      title,
      message,
      type: "system",
    }, false);
  }

  /**
   * 獲取用戶群組ID列表
   */
  private static async getUserGroups(groups: { workers?: boolean; employers?: boolean; admins?: boolean }): Promise<string[]> {
    try {
      // 檢查是否有任何群組被指定
      const hasGroups = groups.workers || groups.employers || groups.admins;
      
      if (!hasGroups) {
        return [];
      }

      // 構建 UNIONALL 查詢
      let unionQuery: any = undefined;

      if (groups.workers) {
        unionQuery = dbClient.select({
          id: workers.workerId
        }).from(workers);
      }

      if (groups.employers) {
        const employerQuery = dbClient.select({
          id: employers.employerId
        }).from(employers);
        
        if (unionQuery) {
          unionQuery = unionQuery.unionAll(employerQuery);
        } else {
          unionQuery = employerQuery;
        }
      }

      if (groups.admins) {
        const adminQuery = dbClient.select({
          id: admins.adminId
        }).from(admins);
        
        if (unionQuery) {
          unionQuery = unionQuery.unionAll(adminQuery);
        } else {
          unionQuery = adminQuery;
        }
      }

      const results = await unionQuery;
      return results.map((result: { id: any; }) => result.id);
    } catch (error) {
      console.error("獲取用戶群組失敗:", error);
      return [];
    }
  }

  /**
   * 發送通知給指定用戶群組
   */
  static async notifyUserGroups(
    groups: { workers?: boolean; employers?: boolean; admins?: boolean },
    title: string,
    message: string,
    type: NotificationType,
    resourceId?: string,
    additionalResourceId?: string,
  ) {
    const targetUsers = await this.getUserGroups(groups);
    return this.createBatch(targetUsers, { title, message, type, resourceId, additionalResourceId });
  }
}

export default NotificationHelper; 