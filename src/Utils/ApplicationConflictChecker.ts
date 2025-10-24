import dbClient from "../Client/DrizzleClient";
import { gigApplications, gigs } from "../Schema/DatabaseSchema";
import { sql, eq, and, lte, gte, lt, gt, ne, inArray } from "drizzle-orm";
import { DateUtils } from "./DateUtils";

export class ApplicationConflictChecker {
  /**
   * 檢查打工者在指定時間是否有已確認的工作（衝突檢查）
   */
  static async checkWorkerScheduleConflict(
    workerId: string,
    gigId: string
  ): Promise<{
    hasConflict: boolean;
    conflictingGigs: Array<{
      gigId: string;
      title: string;
      dateStart: string;
      dateEnd: string;
      timeStart: string;
      timeEnd: string;
    }>;
  }> {
    try {
      const targetGig = await dbClient
        .select({
          gigId: gigs.gigId,
          title: gigs.title,
          dateStart: gigs.dateStart,
          dateEnd: gigs.dateEnd,
          timeStart: gigs.timeStart,
          timeEnd: gigs.timeEnd,
        })
        .from(gigs)
        .where(eq(gigs.gigId, gigId))
        .limit(1)
        .then((rows) => rows[0]);

      if (!targetGig) {
        return { hasConflict: false, conflictingGigs: [] };
      }

      const targetDateStart = DateUtils.formatDate(targetGig.dateStart);
      const targetDateEnd = DateUtils.formatDate(targetGig.dateEnd);
      const timeStart = sql`${targetGig.timeStart}::time without time zone`;
      const timeEnd = sql`${targetGig.timeEnd}::time without time zone`;
      const result = await dbClient
        .select({
          gigId: gigs.gigId,
          title: gigs.title,
          dateStart: gigs.dateStart,
          dateEnd: gigs.dateEnd,
          timeStart: gigs.timeStart,
          timeEnd: gigs.timeEnd,
        })
        .from(gigApplications)
        .innerJoin(gigs, eq(gigApplications.gigId, gigs.gigId))
        .where(
          and(
            eq(gigApplications.workerId, workerId),
            eq(gigApplications.status, "worker_confirmed"),
            eq(gigs.isActive, true),
            ne(gigs.gigId, gigId),
            lte(gigs.dateStart, targetDateEnd),
            gte(gigs.dateEnd, targetDateStart),
            lt(sql`${gigs.timeStart}::time without time zone`, timeEnd),
            gt(sql`${gigs.timeEnd}::time without time zone`, timeStart),
          )
        );
      
      const conflictingGigs = result;

      return {
        hasConflict: conflictingGigs.length > 0,
        conflictingGigs,
      };
    } catch (error) {
      console.error("檢查時間衝突時發生錯誤:", error);
      throw error;
    }
  }

  /**
   * 獲取所有與指定工作時間衝突的待回覆申請
   * 用於打工者確認工作時，自動取消其他衝突的申請
   */
  static async getConflictingPendingApplications(
    workerId: string,
    gigId: string
  ): Promise<string[]> {
    try {
      const targetGig = await dbClient
        .select({
          dateStart: gigs.dateStart,
          dateEnd: gigs.dateEnd,
          timeStart: gigs.timeStart,
          timeEnd: gigs.timeEnd,
        })
        .from(gigs)
        .where(eq(gigs.gigId, gigId))
        .limit(1)
        .then((rows) => rows[0]);

      if (!targetGig) {
        return [];
      }

      const targetDateStart = DateUtils.formatDate(targetGig.dateStart);
      const targetDateEnd = DateUtils.formatDate(targetGig.dateEnd);
      const result = await dbClient
        .select({
          applicationId: gigApplications.applicationId,
        })
        .from(gigApplications)
        .innerJoin(gigs, eq(gigApplications.gigId, gigs.gigId))
        .where(
          and(
            eq(gigApplications.workerId, workerId),
            inArray(gigApplications.status, ["pending_worker_confirmation", "pending_employer_review"]),
            ne(gigs.gigId, gigId),
            lte(gigs.dateStart, targetDateEnd),
            gte(gigs.dateEnd, targetDateStart),
            lt(gigs.timeStart, targetGig.timeEnd),
            gt(gigs.timeEnd, targetGig.timeStart)
          )
        );

      const conflictingApplicationIds = result.map((row) => row.applicationId);

      return conflictingApplicationIds;
    } catch (error) {
      console.error("獲取衝突申請時發生錯誤:", error);
      throw error;
    }
  }

}

