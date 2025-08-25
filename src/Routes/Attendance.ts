import { Hono } from "hono";
import { authenticated } from "../Middleware/authentication";
import { requireApprovedEmployer, requireEmployer, requireWorker } from "../Middleware/guards";
import type IRouter from "../Interfaces/IRouter";
import type { HonoGenericContext } from "../Types/types";
import dbClient from "../Client/DrizzleClient";
import { eq, and, desc, gte, lte, sql } from "drizzle-orm";
import { 
  gigs, 
  attendanceCodes, 
  attendanceRecords, 
  gigApplications,
  employers
} from "../Schema/DatabaseSchema";
import { zValidator } from "@hono/zod-validator";
import {
  attendanceCheckSchema,
  getAttendanceRecordsSchema,
  updateAttendanceRecordSchema
} from "../Types/zodSchema";
import moment from "moment";

const router = new Hono<HonoGenericContext>();

/**
 * 打工者打卡
 * POST /attendance/check
 */
router.post(
  "/check",
  authenticated,
  requireWorker,
  zValidator("json", attendanceCheckSchema),
  async (c) => {
    const user = c.get("user");
    const { workerId, gigId, attendanceCode, checkType } = c.req.valid("json");
    
    if (user.workerId !== workerId) {
      return c.json({
        message: "工作者ID不匹配"
      }, 403);
    }

    try {
      const today = moment().format("YYYY-MM-DD");
      
      // 驗證打卡碼
      const validCode = await dbClient.query.attendanceCodes.findFirst({
        where: and(
          eq(attendanceCodes.gigId, gigId),
          eq(attendanceCodes.attendanceCode, attendanceCode),
          eq(attendanceCodes.validDate, today),
          gte(attendanceCodes.expiresAt, sql`now()`)
        )
      });

      if (!validCode) {
        return c.json({
          message: "無效的打卡碼或打卡碼已過期"
        }, 400);
      }

      // 檢查是否有核准的工作申請
      const application = await dbClient.query.gigApplications.findFirst({
        where: and(
          eq(gigApplications.workerId, workerId),
          eq(gigApplications.gigId, gigId),
          eq(gigApplications.status, "approved")
        )
      });

      if (!application) {
        return c.json({
          message: "未找到核准的工作申請"
        }, 404);
      }

      // 獲取工作資訊以判斷是否準時
      const gig = await dbClient.query.gigs.findFirst({
        where: eq(gigs.gigId, gigId),
        columns: {
          timeStart: true,
          timeEnd: true
        }
      });

      if (!gig) {
        return c.json({
          message: "工作不存在"
        }, 404);
      }

      // 檢查打卡記錄狀態
      const todayRecords = await dbClient.query.attendanceRecords.findMany({
        where: and(
          eq(attendanceRecords.workerId, workerId),
          eq(attendanceRecords.gigId, gigId),
          eq(attendanceRecords.workDate, today)
        )
      });

      const hasCheckIn = todayRecords.some(record => record.checkType === "check_in");
      const hasCheckOut = todayRecords.some(record => record.checkType === "check_out");

      // 檢查重複打卡
      if (checkType === "check_in" && hasCheckIn) {
        return c.json({
          message: "今日已經上班打卡，請勿重複打卡"
        }, 400);
      }

      if (checkType === "check_out" && hasCheckOut) {
        return c.json({
          message: "今日已經下班打卡，請勿重複打卡"
        }, 400);
      }

      // 檢查下班打卡前必須先上班打卡
      if (checkType === "check_out" && !hasCheckIn) {
        return c.json({
          message: "尚未上班打卡，無法下班打卡"
        }, 400);
      }

      // 判斷打卡狀態和時間限制
      const now = moment();
      const todayTimeStart = moment(`${today} ${gig.timeStart}`);
      const todayTimeEnd = moment(`${today} ${gig.timeEnd}`);
      
      let status: "on_time" | "late" | "early";
      
      if (checkType === "check_in") {
        // 上班打卡：最早工作開始前 30 分鐘，最晚遲到 30 分鐘
        const earliestAllowed = todayTimeStart.clone().subtract(30, 'minutes');
        const latestAllowed = todayTimeStart.clone().add(30, 'minutes');
        
        if (now.isBefore(earliestAllowed)) {
          return c.json({
            message: `打卡過早，最早可在 ${earliestAllowed.format('HH:mm')} 後打卡`
          }, 400);
        }
        
        if (now.isAfter(latestAllowed)) {
          return c.json({
            message: `打卡過晚，最遲可在 ${latestAllowed.format('HH:mm')} 前打卡`
          }, 400);
        }
        
        if (now.isAfter(todayTimeStart)) {
          status = "late";
        } else {
          status = "on_time";
        }
      } else {
        // 下班打卡：最早可在工作結束時間打卡，最遲延後 30 分鐘
        const latestAllowed = todayTimeEnd.clone().add(30, 'minutes');
        
        if (now.isBefore(todayTimeEnd)) {
          status = "early";
        } else if (now.isAfter(latestAllowed)) {
          return c.json({
            message: `打卡過晚，最遲可在 ${latestAllowed.format('HH:mm')} 前打卡`
          }, 400);
        } else {
          status = "on_time";
        }
      }

      await dbClient.insert(attendanceRecords).values({
        gigId,
        workerId,
        attendanceCodeId: validCode.codeId,
        checkType,
        workDate: today,
        status: status
      });

      return c.json({
        message: "打卡成功",
      });

    } catch (error) {
      console.error("打卡時出錯:", error);
      return c.json({
        message: "打卡失敗"
      }, 500);
    }
  }
);

/**
 * 打工者查看今天的工作安排
 * GET /attendance/today-jobs
 */
router.get(
  "/today-jobs",
  authenticated,
  requireWorker,
  async (c) => {
    const user = c.get("user");
    
    try {
      const today = moment().format("YYYY-MM-DD");
      
      const todayJobs = await dbClient
        .select({
          gigId: gigs.gigId,
          title: gigs.title,
          timeStart: gigs.timeStart,
          timeEnd: gigs.timeEnd,
          city: gigs.city,
          district: gigs.district,
          address: gigs.address,
        })
        .from(gigApplications)
        .innerJoin(gigs, eq(gigApplications.gigId, gigs.gigId))
        .innerJoin(employers, eq(gigs.employerId, employers.employerId))
        .where(and(
          eq(gigApplications.workerId, user.workerId),
          eq(gigApplications.status, "approved"),
          lte(gigs.dateStart, today),
          gte(gigs.dateEnd, today)
        ));
      
      return c.json({
        date: today,
        jobs: todayJobs,
        total: todayJobs.length
      });

    } catch (error) {
      console.error("查詢今日工作時出錯:", error);
      return c.json({
        message: "查詢失敗"
      }, 500);
    }
  }
);

/**
 * 查看打卡記錄
 * GET /attendance/records
 */
router.get(
  "/records",
  authenticated,
  zValidator("query", getAttendanceRecordsSchema),
  async (c) => {
    const user = c.get("user");
    const { 
      gigId, 
      workerId,
      checkType
    } = c.req.valid("query");

    try {
      const dateStart = c.req.query("dateStart");
      const dateEnd = c.req.query("dateEnd");
      const limit = c.req.query("limit") || "10";
      const offset = c.req.query("offset") || "0";
      const requestLimit = Number.parseInt(limit);
      const requestOffset = Number.parseInt(offset);
      const whereConditions = [];

      if (dateStart && dateEnd && moment(dateEnd).isBefore(moment(dateStart))) {
        return c.json({
          message: "結束日期不能早於開始日期"
        }, 400);
      }

      if (user.role === "worker") {
        if (workerId !== user.workerId) {
          return c.json({
            message: "無權限查看其他工作者的記錄"
          }, 403);
        }

        whereConditions.push(eq(attendanceRecords.workerId, user.workerId));
      } else if (user.role === "employer") {
        const gig = await dbClient.query.gigs.findFirst({
          where: and(
            eq(gigs.gigId, gigId),
            eq(gigs.employerId, user.employerId)
          ),
          columns: { gigId: true }
        });
        
        if (!gig) {
          return c.json({
            message: "工作不存在或無權限查看"
          }, 404);
        }
        
        whereConditions.push(eq(attendanceRecords.gigId, gigId));
      }

      // 其他篩選條件
      if (dateStart) whereConditions.push(gte(attendanceRecords.workDate, dateStart));
      if (dateEnd) whereConditions.push(lte(attendanceRecords.workDate, dateEnd));
      if (checkType) whereConditions.push(eq(attendanceRecords.checkType, checkType));

      // 查詢記錄
      const records = await dbClient.query.attendanceRecords.findMany({
        where: and(...whereConditions),
        orderBy: [desc(attendanceRecords.createdAt)],
        limit: requestLimit + 1, // 多查一筆來判斷hasMore
        offset: requestOffset,
        with: {
          gig: {
            columns: {
              title: true,
              timeStart: true,
              timeEnd: true,
            }
          },
          worker: {
            columns: {
              firstName: true,
              lastName: true,
              profilePhoto: true
            }
          }
        }
      });

      const hasMore = records.length > requestLimit;
      const returnRecords = hasMore ? records.slice(0, requestLimit) : records;

      const formattedRecords = returnRecords.map(record => ({
        recordId: record.recordId,
        gigId: record.gigId,
        checkType: record.checkType,
        workDate: record.workDate,
        status: record.status,
        notes: record.notes,
        gig: user.role === "worker" ? record.gig : undefined,
        worker: user.role === "employer" ? record.worker : undefined,
        updatedAt: record.updatedAt,
        createdAt: record.createdAt
      }));

      return c.json({
        records: formattedRecords,
        pagination: {
          limit: requestLimit,
          offset: requestOffset,
          hasMore,
          returned: formattedRecords.length
        }
      });

    } catch (error) {
      console.error("查詢打卡記錄時出錯:", error);
      return c.json({
        message: "查詢失敗"
      }, 500);
    }
  }
);

/**
 * 雇主修改打卡記錄
 * PUT /attendance/record
 */
router.put(
  "/record",
  authenticated,
  requireEmployer,
  requireApprovedEmployer,
  zValidator("json", updateAttendanceRecordSchema),
  async (c) => {
    const { recordId, status, notes } = c.req.valid("json");

    try {
      const record = await dbClient
        .select({
          recordId: attendanceRecords.recordId,
          status: attendanceRecords.status,
          notes: attendanceRecords.notes,
        })
        .from(attendanceRecords)
        .where(eq(attendanceRecords.recordId, recordId))
        .limit(1);

      if (record.length === 0) {
        return c.json({
          message: "打卡記錄不存在或無權限修改"
        }, 404);
      }

      const [updatedRecord] = await dbClient
        .update(attendanceRecords)
        .set({
          status,
          notes,
          updatedAt: sql`now()`
        })
        .where(eq(attendanceRecords.recordId, recordId))
        .returning();

      return c.json({
        message: "打卡記錄更新成功",
        record: {
          recordId: updatedRecord.recordId,
          checkType: updatedRecord.checkType,
          status: updatedRecord.status,
          notes: updatedRecord.notes,
          updatedAt: updatedRecord.updatedAt
        }
      });

    } catch (error) {
      console.error("更新打卡記錄時出錯:", error);
      return c.json({
        message: "更新失敗"
      }, 500);
    }
  }
);

export default { path: "/attendance", router } as IRouter;