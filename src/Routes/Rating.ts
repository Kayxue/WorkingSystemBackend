import { Hono } from "hono";
import { authenticated } from "../Middleware/authentication";
import { requireWorker, requireEmployer, requireApprovedEmployer } from "../Middleware/guards";
import type IRouter from "../Interfaces/IRouter";
import type { HonoGenericContext } from "../Types/types";
import dbClient from "../Client/DrizzleClient";
import { eq, and, desc, sql, count, lt, avg } from "drizzle-orm";
import { gigs, gigApplications, workers, employers, workerRatings, employerRatings } from "../Schema/DatabaseSchema";
import { zValidator } from "@hono/zod-validator";
import { createRatingSchema } from "../Types/zodSchema";
import { DateUtils } from "../Utils/DateUtils";

const router = new Hono<HonoGenericContext>();

// ========== 商家對打工者評分（基於工作）==========

/**
 * 商家對打工者評分
 * POST /rating/worker/:workerId/gig/:gigId
 */
router.post(
  "/worker/:workerId/gig/:gigId",
  authenticated,
  requireEmployer,
  requireApprovedEmployer,
  zValidator("json", createRatingSchema),
  async (c) => {
    try {
      const user = c.get("user");
      const gigId = c.req.param("gigId");
      const workerId = c.req.param("workerId");
      const { ratingValue, comment } = c.req.valid("json");
      const employerId = user.employerId;

      // 檢查是否已經評分過
      const existingRating = await dbClient.query.workerRatings.findFirst({
        where: and(
          eq(workerRatings.gigId, gigId),
          eq(workerRatings.workerId, workerId),
          eq(workerRatings.employerId, employerId)
        ),
        columns: {
          ratingId: true
        }
      });

      if (existingRating) {
        return c.json({
          message: "您已經對這位打工者評分過了",
        }, 400);
      }

      // 直接查詢符合所有條件的記錄，並檢查工作是否已結束
      const currentDate = DateUtils.getCurrentDate(); // YYYY-MM-DD 格式
      const validGig = await dbClient.query.gigs.findFirst({
        where: and(
          eq(gigs.gigId, gigId),
          eq(gigs.employerId, employerId),
          lt(gigs.dateEnd, currentDate) // 工作必須已結束
        ),
        columns: {
          gigId: true
        },
        with: {
          gigApplications: {
            where: and(
              eq(gigApplications.workerId, workerId),
              eq(gigApplications.status, "worker_confirmed")
            ),
            limit: 1,
            columns: {
              applicationId: true
            }
          }
        }
      });

      if (!validGig) {
        return c.json({
          message: "找不到可評分的工作、指定的打工者沒有已批准的申請，或工作尚未結束",
        }, 404);
      }

      // 創建評分
      const [newRating] = await dbClient
        .insert(workerRatings)
        .values({
          gigId,
          workerId,
          employerId,
          ratingValue,
          comment: comment || null,
        })
        .returning();

      return c.json({
        message: "評分成功",
        data: {
          ratingId: newRating.ratingId,
          ratingValue: newRating.ratingValue,
          comment: newRating.comment,
          createdAt: newRating.createdAt,
        },
      }, 201);
    } catch (error) {
      console.error("評分打工者時發生錯誤:", error);
      return c.json({
        message: "評分失敗，請稍後再試",
      }, 500);
    }
  }
);

/**
 * 打工者對商家評分
 * POST /rating/employer/:employerId/gig/:gigId
 */
router.post(
  "/employer/:employerId/gig/:gigId",
  authenticated,
  requireWorker,
  zValidator("json", createRatingSchema),
  async (c) => {
    try {
      const user = c.get("user");
      const gigId = c.req.param("gigId");
      const employerId = c.req.param("employerId");
      const { ratingValue, comment } = c.req.valid("json");
      const workerId = user.workerId;

      // 檢查是否已經評分過
      const existingRating = await dbClient.query.employerRatings.findFirst({
        where: and(
          eq(employerRatings.gigId, gigId),
          eq(employerRatings.workerId, workerId),
          eq(employerRatings.employerId, employerId)
        ),
        columns: {
          ratingId: true
        }
      });

      if (existingRating) {
        return c.json({
          message: "您已經對這個商家評分過了",
        }, 400);
      }

      // 直接查詢符合所有條件的記錄，並檢查工作是否已結束
      const currentDate = DateUtils.getCurrentDate(); // YYYY-MM-DD 格式
      const validGig = await dbClient.query.gigs.findFirst({
        where: and(
          eq(gigs.gigId, gigId),
          eq(gigs.employerId, employerId),
          lt(gigs.dateEnd, currentDate) // 工作必須已結束
        ),
        columns: {
          gigId: true
        },
        with: {
          gigApplications: {
            where: and(
              eq(gigApplications.workerId, workerId),
              eq(gigApplications.status, "worker_confirmed")
            ),
            limit: 1,
            columns: {
              applicationId: true
            }
          }
        }
      });

      if (!validGig) {
        return c.json({
          message: "找不到可評分的工作、您沒有此工作的已批准申請，或工作尚未結束",
        }, 404);
      }

      // 創建評分
      const [newRating] = await dbClient
        .insert(employerRatings)
        .values({
          gigId,
          employerId,
          workerId,
          ratingValue,
          comment: comment || null,
        })
        .returning();

      return c.json({
        message: "評分成功",
        data: {
          ratingId: newRating.ratingId,
          ratingValue: newRating.ratingValue,
          comment: newRating.comment,
          createdAt: newRating.createdAt,
        },
      }, 201);
    } catch (error) {
      console.error("評分商家時發生錯誤:", error);
      return c.json({
        message: "評分失敗，請稍後再試",
      }, 500);
    }
  }
);

// ========== 評分查詢 ==========

/**
 * 商家查看打工者的評分統計
 * GET /rating/worker/:workerId
 */
router.get("/worker/:workerId", authenticated, requireEmployer, requireApprovedEmployer, async (c) => {
  try {
    const workerId = c.req.param("workerId");

    // 驗證打工者是否存在
    const worker = await dbClient.query.workers.findFirst({
      where: eq(workers.workerId, workerId),
      columns: {
        firstName: true,
        lastName: true,
      },
    });

    if (!worker) {
      return c.json({
        message: "找不到指定的打工者",
      }, 404);
    }

    // 使用單一查詢計算總評數和總分
    const ratingStats = await dbClient
      .select({
        count: count(),
        average: avg(workerRatings.ratingValue),
      })
      .from(workerRatings)
      .where(eq(workerRatings.workerId, workerId));

    const totalRatings = ratingStats[0].count;
    const averageRating = totalRatings > 0 ? Number(ratingStats[0].average) : 0;

    return c.json({
      data: {
        worker: {
          workerId,
          name: `${worker.firstName} ${worker.lastName}`,
        },
        summary: {
          totalRatings,
          averageRating: Number(averageRating.toFixed(2)),
        },
      },
    }, 200);
  } catch (error) {
    console.error("獲取打工者評分時發生錯誤:", error);
    return c.json({
      message: "獲取評分失敗，請稍後再試",
    }, 500);
  }
});

/**
 * 打工者查看商家的評分統計
 * GET /rating/employer/:employerId
 */
router.get("/employer/:employerId", authenticated, requireWorker, async (c) => {
  try {
    const employerId = c.req.param("employerId");

    // 驗證商家是否存在
    const employer = await dbClient.query.employers.findFirst({
      where: eq(employers.employerId, employerId),
      columns: {
        employerName: true,
        branchName: true,
      },
    });

    if (!employer) {
      return c.json({
        message: "找不到指定的商家",
      }, 404);
    }

    // 使用單一查詢計算總評數和平均分
    const ratingStats = await dbClient
      .select({
        count: count(),
        average: avg(employerRatings.ratingValue),
      })
      .from(employerRatings)
      .where(eq(employerRatings.employerId, employerId));

    const totalRatings = ratingStats[0].count;
    const averageRating = totalRatings > 0 ? Number(ratingStats[0].average) : 0;

    return c.json({
      data: {
        employer: {
          employerId,
          name: employer.branchName ? `${employer.employerName} - ${employer.branchName}` : employer.employerName,
        },
        summary: {
          totalRatings,
          averageRating: Number(averageRating.toFixed(2)),
        },
      },
    }, 200);
  } catch (error) {
    console.error("獲取商家評分時發生錯誤:", error);
    return c.json({
      message: "獲取評分失敗，請稍後再試",
    }, 500);
  }
});

// ========== 我的評分 ==========

/**
 * 商家獲取自己給出的所有評分
 * GET /rating/my-ratings/employer
 */
router.get("/my-ratings/employer", authenticated, requireEmployer, requireApprovedEmployer, async (c) => {
  try {
    const user = c.get("user");
    const limit = c.req.query("limit") || "10";
    const offset = c.req.query("offset") || "0";
    const requestLimit = Number.parseInt(limit);
    const requestOffset = Number.parseInt(offset);
    const employerId = user.employerId;

    // 獲取商家的所有評分
    const myRatings = await dbClient.query.workerRatings.findMany({
      where: eq(workerRatings.employerId, employerId),
      columns: {
        ratingId: true,
        ratingValue: true,
        comment: true,
        createdAt: true,
      },
      with: {
        worker: {
          columns: {
            workerId: true,
            firstName: true,
            lastName: true,
          },
        },
        gig: {
          columns: {
            gigId: true,
            title: true,
            dateStart: true,
            dateEnd: true,
          },
        },
      },
      orderBy: [desc(workerRatings.createdAt)],
      limit: requestLimit + 1, // 多查一筆來確認是否有更多資料
      offset: requestOffset,
    });

    const hasMore = myRatings.length > requestLimit;
    const returnRatings = hasMore ? myRatings.slice(0, requestLimit) : myRatings;

    return c.json({
      data: {
        myRatings: returnRatings.map((rating) => ({
          ratingId: rating.ratingId,
          worker: {
            workerId: rating.worker.workerId,
            name: `${rating.worker.firstName} ${rating.worker.lastName}`,
          },
          gig: {
            gigId: rating.gig.gigId,
            title: rating.gig.title,
            startDate: rating.gig.dateStart,
            endDate: rating.gig.dateEnd,
          },
          ratingValue: rating.ratingValue,
          comment: rating.comment,
          createdAt: rating.createdAt,
        })),
        pagination: {
          limit: requestLimit,
          offset: requestOffset,
          hasMore,
          returned: returnRatings.length,
        },
      },
    }, 200);
  } catch (error) {
    console.error("獲取商家評分記錄時發生錯誤:", error);
    return c.json({
      message: "獲取評分記錄失敗，請稍後再試",
    }, 500);
  }
});

/**
 * 打工者獲取自己給出的所有評分
 * GET /rating/my-ratings/worker
 */
router.get("/my-ratings/worker", authenticated, requireWorker, async (c) => {
  try {
    const user = c.get("user");
    const limit = c.req.query("limit") || "10";
    const offset = c.req.query("offset") || "0";
    const requestLimit = Number.parseInt(limit);
    const requestOffset = Number.parseInt(offset);
    const workerId = user.workerId;

    // 獲取打工者的所有評分
    const myRatings = await dbClient.query.employerRatings.findMany({
      where: eq(employerRatings.workerId, workerId),
      columns: {
        ratingId: true,
        ratingValue: true,
        comment: true,
        createdAt: true,
      },
      with: {
        employer: {
          columns: {
            employerId: true,
            employerName: true,
            branchName: true,
          },
        },
        gig: {
          columns: {
            gigId: true,
            title: true,
            dateStart: true,
            dateEnd: true,
          },
        },
      },
      orderBy: [desc(employerRatings.createdAt)],
      limit: requestLimit + 1, // 多查一筆來確認是否有更多資料
      offset: requestOffset,
    });

    const hasMore = myRatings.length > requestLimit;
    const returnRatings = hasMore ? myRatings.slice(0, requestLimit) : myRatings;

    return c.json({
      data: {
        myRatings: returnRatings.map((rating) => ({
          ratingId: rating.ratingId,
          employer: {
            employerId: rating.employer.employerId,
            name: rating.employer.branchName ? `${rating.employer.employerName} - ${rating.employer.branchName}` : rating.employer.employerName,
          },
          gig: {
            gigId: rating.gig.gigId,
            title: rating.gig.title,
            startDate: rating.gig.dateStart,
            endDate: rating.gig.dateEnd,
          },
          ratingValue: rating.ratingValue,
          comment: rating.comment,
          createdAt: rating.createdAt,
        })),
        pagination: {
          limit: requestLimit,
          offset: requestOffset,
          hasMore,
          returned: returnRatings.length,
        },
      },
    }, 200);
  } catch (error) {
    console.error("獲取打工者評分記錄時發生錯誤:", error);
    return c.json({
      message: "獲取評分記錄失敗，請稍後再試",
    }, 500);
  }
});

// ========== 收到的評分 ==========

/**
 * 商家獲取別人給自己的所有評分
 * GET /rating/received-ratings/employer
 */
router.get("/received-ratings/employer", authenticated, requireEmployer, async (c) => {
  try {
    const user = c.get("user");
    const limit = c.req.query("limit") || "10";
    const offset = c.req.query("offset") || "0";
    const requestLimit = Number.parseInt(limit);
    const requestOffset = Number.parseInt(offset);
    const employerId = user.employerId;

    // 獲取商家收到的所有評分
    const receivedRatings = await dbClient.query.employerRatings.findMany({
      where: eq(employerRatings.employerId, employerId),
      columns: {
        ratingId: true,
        ratingValue: true,
        comment: true,
        createdAt: true,
      },
      with: {
        worker: {
          columns: {
            workerId: true,
            firstName: true,
            lastName: true,
          },
        },
        gig: {
          columns: {
            gigId: true,
            title: true,
            dateStart: true,
            dateEnd: true,
          },
        },
      },
      orderBy: [desc(employerRatings.createdAt)],
      limit: requestLimit + 1, // 多查一筆來確認是否有更多資料
      offset: requestOffset,
    });

    const hasMore = receivedRatings.length > requestLimit;
    const returnRatings = hasMore ? receivedRatings.slice(0, requestLimit) : receivedRatings;

    return c.json({
      data: {
        receivedRatings: returnRatings.map((rating) => ({
          ratingId: rating.ratingId,
          worker: {
            workerId: rating.worker.workerId,
            name: `${rating.worker.firstName} ${rating.worker.lastName}`,
          },
          gig: {
            gigId: rating.gig.gigId,
            title: rating.gig.title,
            startDate: rating.gig.dateStart,
            endDate: rating.gig.dateEnd,
          },
          ratingValue: rating.ratingValue,
          comment: rating.comment,
          createdAt: rating.createdAt,
        })),
        pagination: {
          limit: requestLimit,
          offset: requestOffset,
          hasMore,
          returned: returnRatings.length,
        },
      },
    }, 200);
  } catch (error) {
    console.error("獲取商家收到的評分記錄時發生錯誤:", error);
    return c.json({
      message: "獲取收到的評分記錄失敗，請稍後再試",
    }, 500);
  }
});

/**
 * 打工者獲取別人給自己的所有評分
 * GET /rating/received-ratings/worker
 */
router.get("/received-ratings/worker", authenticated, requireWorker, async (c) => {
  try {
    const user = c.get("user");
    const limit = c.req.query("limit") || "10";
    const offset = c.req.query("offset") || "0";
    const requestLimit = Number.parseInt(limit);
    const requestOffset = Number.parseInt(offset);
    const workerId = user.workerId;

    // 獲取打工者收到的所有評分
    const receivedRatings = await dbClient.query.workerRatings.findMany({
      where: eq(workerRatings.workerId, workerId),
      columns: {
        ratingId: true,
        ratingValue: true,
        comment: true,
        createdAt: true,
      },
      with: {
        employer: {
          columns: {
            employerId: true,
            employerName: true,
            branchName: true,
          },
        },
        gig: {
          columns: {
            gigId: true,
            title: true,
            dateStart: true,
            dateEnd: true,
          },
        },
      },
      orderBy: [desc(workerRatings.createdAt)],
      limit: requestLimit + 1, // 多查一筆來確認是否有更多資料
      offset: requestOffset,
    });

    const hasMore = receivedRatings.length > requestLimit;
    const returnRatings = hasMore ? receivedRatings.slice(0, requestLimit) : receivedRatings;

    return c.json({
      data: {
        receivedRatings: returnRatings.map((rating) => ({
          ratingId: rating.ratingId,
          employer: {
            employerId: rating.employer.employerId,
            name: rating.employer.branchName ? `${rating.employer.employerName} - ${rating.employer.branchName}` : rating.employer.employerName,
          },
          gig: {
            gigId: rating.gig.gigId,
            title: rating.gig.title,
            startDate: rating.gig.dateStart,
            endDate: rating.gig.dateEnd,
          },
          ratingValue: rating.ratingValue,
          comment: rating.comment,
          createdAt: rating.createdAt,
        })),
        pagination: {
          limit: requestLimit,
          offset: requestOffset,
          hasMore,
          returned: returnRatings.length,
        },
      },
    }, 200);
  } catch (error) {
    console.error("獲取打工者收到的評分記錄時發生錯誤:", error);
    return c.json({
      message: "獲取收到的評分記錄失敗，請稍後再試",
    }, 500);
  }
});

// ========== 可評分列表 ==========

/**
 * 商家對某個工作獲取可以評分的人
 * GET /rating/list/employer/gig/:gigId?status=rated|unrated|all
 */
router.get("/list/employer/gig/:gigId", authenticated, requireEmployer, requireApprovedEmployer, async (c) => {
  try {
    const user = c.get("user");
    const gigId = c.req.param("gigId");
    const limit = c.req.query("limit") || "10";
    const offset = c.req.query("offset") || "0";
    const status = c.req.query("status") || "unrated"; // 預設顯示未評分
    const requestLimit = Number.parseInt(limit);
    const requestOffset = Number.parseInt(offset);
    const employerId = user.employerId;
    const currentDate = DateUtils.getCurrentDate();

    // 驗證篩選參數
    if (!["rated", "unrated", "all"].includes(status)) {
      return c.json({
        message: "無效的篩選參數，請使用 rated、unrated 或 all",
      }, 400);
    }

    // 首先驗證工作是否存在且屬於該商家，並且已結束
    const gig = await dbClient.query.gigs.findFirst({
      where: and(
        eq(gigs.gigId, gigId),
        eq(gigs.employerId, employerId),
        lt(gigs.dateEnd, currentDate) // 工作必須已結束
      ),
      columns: {
        gigId: true,
      },
    });

    if (!gig) {
      return c.json({
        message: "找不到指定的工作、無權限查看，或工作尚未結束",
      }, 404);
    }

    // 建立查詢條件
    const whereConditions = [
      eq(gigApplications.gigId, gigId),
      eq(gigApplications.status, "worker_confirmed"), // 必須是已批准的申請
    ];

    // 根據篩選條件添加評分狀態篩選
    if (status === "rated") {
      whereConditions.push(sql`${workerRatings.ratingId} IS NOT NULL`); // 已評分
    } else if (status === "unrated") {
      whereConditions.push(sql`${workerRatings.ratingId} IS NULL`); // 未評分
    }

    // 查詢該工作中的打工者
    const workerList = await dbClient
      .select({
        workerId: gigApplications.workerId,
        workerFirstName: workers.firstName,
        workerLastName: workers.lastName,
        appliedAt: gigApplications.createdAt,
        ratingId: workerRatings.ratingId,
        ratingValue: workerRatings.ratingValue,
        ratingComment: workerRatings.comment,
        ratedAt: workerRatings.createdAt,
      })
      .from(gigApplications)
      .innerJoin(workers, eq(gigApplications.workerId, workers.workerId))
      .leftJoin(workerRatings, and(
        eq(workerRatings.gigId, gigId),
        eq(gigApplications.workerId, workerRatings.workerId),
        eq(workerRatings.employerId, employerId)
      ))
      .where(and(...whereConditions))
      .orderBy(gigApplications.createdAt)
      .limit(requestLimit + 1) // 多查一筆來確認是否有更多資料
      .offset(requestOffset);

    const hasMore = workerList.length > requestLimit;
    const returnWorkers = hasMore ? workerList.slice(0, requestLimit) : workerList;

    return c.json({
      data: {
        workers: returnWorkers.map((worker) => ({
          workerId: worker.workerId,
          name: `${worker.workerFirstName} ${worker.workerLastName}`,
          appliedAt: worker.appliedAt,
          isRated: worker.ratingId !== null,
          rating: worker.ratingId ? {
            ratingId: worker.ratingId,
            ratingValue: worker.ratingValue,
            comment: worker.ratingComment,
            ratedAt: worker.ratedAt,
          } : null,
        })),
        pagination: {
          limit: requestLimit,
          offset: requestOffset,
          hasMore,
          returned: returnWorkers.length,
        },
      },
    }, 200);
  } catch (error) {
    console.error("獲取打工者列表時發生錯誤:", error);
    return c.json({
      message: "獲取打工者列表失敗，請稍後再試",
    }, 500);
  }
});

/**
 * 打工者獲取可以評分的工作列表
 * GET /rating/list/worker
 */
router.get("/list/worker", authenticated, requireWorker, async (c) => {
  try {
    const user = c.get("user");
    const page = c.req.query("page")
    const requestLimit = 10;
    const requestOffset = requestLimit * (Number.parseInt(page) - 1) || 0;
    const workerId = user.workerId;
    const currentDate = DateUtils.getCurrentDate();

    // 查詢該打工者可評分的工作
    const ratableGigs = await dbClient
      .select({
        gigId: gigs.gigId,
        title: gigs.title,
        dateStart: gigs.dateStart,
        dateEnd: gigs.dateEnd,
        employerId: employers.employerId,
        employerName: employers.employerName,
        branchName: employers.branchName,
      })
      .from(gigApplications)
      .innerJoin(gigs, eq(gigApplications.gigId, gigs.gigId))
      .innerJoin(employers, eq(gigs.employerId, employers.employerId))
      .leftJoin(employerRatings, and(
        eq(gigs.gigId, employerRatings.gigId),
        eq(employerRatings.workerId, workerId),
        eq(employerRatings.employerId, gigs.employerId)
      ))
      .where(and(
        eq(gigApplications.workerId, workerId),
        eq(gigApplications.status, "worker_confirmed"),
        lt(gigs.dateEnd, currentDate), // 工作必須已結束
        sql`${employerRatings.ratingId} IS NULL` // 該打工者未評分
      ))
      .orderBy(desc(gigs.dateEnd))
      .limit(requestLimit + 1) // 多查一筆來確認是否有更多資料
      .offset(requestOffset);

    const hasMore = ratableGigs.length > requestLimit;
    const returnGigs = hasMore ? ratableGigs.slice(0, requestLimit) : ratableGigs;

    return c.json({
      ratableGigs: returnGigs.map((gig) => ({
        gigId: gig.gigId,
        title: gig.title,
        startDate: gig.dateStart,
        endDate: gig.dateEnd,
        employer: {
          employerId: gig.employerId,
          name: gig.branchName ? `${gig.employerName} - ${gig.branchName}` : gig.employerName,
        },
      })),
      pagination: {
        limit: requestLimit,
        page: Number.parseInt(page) || 1,
        hasMore,
        returned: returnGigs.length,
      },
    }, 200);
  } catch (error) {
    console.error("獲取可評分工作時發生錯誤:", error);
    return c.json({
      message: "獲取可評分工作失敗，請稍後再試",
    }, 500);
  }
});

export default { path: "/rating", router } as IRouter;