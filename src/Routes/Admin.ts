import { Hono } from "hono";
import type IRouter from "../Interfaces/IRouter";
import type { HonoGenericContext } from "../Types/types";
import { authenticated } from "../Middleware/authentication";
import { requireAdmin } from "../Middleware/guards";
import dbClient from "../Client/DrizzleClient";
import { eq, sql } from "drizzle-orm";
import { admins, employers, workers } from "../Schema/DatabaseSchema";
import { zValidator } from "@hono/zod-validator";
import { adminRegisterSchema } from "../Types/zodSchema";
import { hash } from "@node-rs/argon2";
import { argon2Config } from "../config";
import NotificationHelper from "../Utils/NotificationHelper";
import { UserCache } from "../Client/Cache/Index";
import { Role } from "../Types/types";
import SessionManager from "../Utils/SessionManager";
import {FileManager} from "../Client/Cache/Index";

const router = new Hono<HonoGenericContext>();

router.post("/register", zValidator("json", adminRegisterSchema), async (c) => {
	const { email, password } = c.req.valid("json");
	const hashedPassword = await hash(password, argon2Config);
	const newAdmin = await dbClient
		.insert(admins)
		.values({ email, password: hashedPassword })
		.returning();
	return c.json(newAdmin[0]);
});

router.get("/pendingEmployer", authenticated, requireAdmin, async (c) => {
	let pendingEmployers = await dbClient.query.employers.findMany({
		where: eq(employers.approvalStatus, "pending"),
		columns: {
			password: false,
			fcmTokens: false,
		},
	});

  //
  pendingEmployers = await Promise.all(
    pendingEmployers.map(async (employer,index)=> {
      const employerPhoto = employer.employerPhoto as {
        originalName: string;
        r2Name: string;
        type: string;
      };
      let photoUrlData = null;
      console.log(employerPhoto);
      if (employerPhoto && employerPhoto.r2Name) {
        const url = await FileManager.getPresignedUrl(`profile-photos/employers/${employerPhoto.r2Name}`);
        if (url) {
          photoUrlData = {
          url: url,
          originalName: employerPhoto.originalName,
          type: employerPhoto.type,
          };
        }
        employer.employerPhoto = photoUrlData;	
      } else {
        console.log("No employer photo found for employer:", employer.employerId);
        employer.employerPhoto = null;
      }

      let documentsWithUrls = [];

      if (employer.verificationDocuments && Array.isArray(employer.verificationDocuments)) {
        documentsWithUrls = await Promise.all(
          employer.verificationDocuments.map(async (doc) => {
            if (!doc || !doc.r2Name) {
              return null;
            }

            const presignedUrl = await FileManager.getPresignedUrl(`identification/${employer.employerId}/${doc.r2Name}`);

            if (presignedUrl) {
              return {
                url: presignedUrl,
                originalName: doc.originalName,
                type: doc.type,
              };
            } else {
              return null;
            }
          }
        ));
      }
      employer.verificationDocuments = documentsWithUrls.filter(doc => doc !== null);
      return employer;

    }
  ));

	return c.json(pendingEmployers);
});

router.patch(
	"/approveEmployer/:id",
	authenticated,
	requireAdmin,
	async (c) => {
		const id = c.req.param("id");
		const employerFound = await dbClient.query.employers.findFirst({
			where: eq(employers.employerId, id),
		});
		if (!employerFound) {
			return c.text("Employer not found", 404);
		}
		if (employerFound.approvalStatus !== "pending") {
			return c.text("Employer is not pending approval", 400);
		}
		const updatedEmployer = await dbClient
			.update(employers)
			.set({ approvalStatus: "approved" })
			.where(eq(employers.employerId, id))
			.returning();

		// 發送審核通過通知
		await NotificationHelper.notifyAccountApproved(
			employerFound.employerId,
			Role.EMPLOYER,
			employerFound.employerName
		);

		await UserCache.clearUserProfile(employerFound.employerId, Role.EMPLOYER);
		return c.json(updatedEmployer[0]);
	},
);

router.patch("/rejectEmployer/:id", authenticated, requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const reason = body.reason || "請聯繫客服了解詳情";
  const employerFound = await dbClient.query.employers.findFirst({
    where: eq(employers.employerId, id),
  });

  if (!employerFound) {
    return c.text("Employer not found", 404);
  }

  if (employerFound.approvalStatus !== "pending") {
    return c.text("Employer is not in pending status", 400);
  }

  const updatedEmployer = await dbClient
    .update(employers)
    .set({ approvalStatus: "rejected" })
    .where(eq(employers.employerId, id))
    .returning();
  
  // 發送審核拒絕通知
  await NotificationHelper.notifyAccountRejected(
    employerFound.employerId,
    Role.EMPLOYER,
    employerFound.employerName,
    reason
  );

  await UserCache.clearUserProfile(employerFound.employerId, Role.EMPLOYER);
  return c.json(updatedEmployer[0]);
});
  
// 踢用戶下線
router.post("/kick-user/:userId", authenticated, async (c) => {
	const userId = c.req.param("userId");

	try {
		await SessionManager.clear(userId);
		return c.json({ message: `用戶 ${userId} 已被踢下線` });
	} catch (error) {
		console.error("踢用戶下線失敗:", error);
		return c.text("踢用戶下線失敗", 500);
	}
});

// 獲取所有活躍 sessions
router.get("/active-sessions", authenticated, async (c) => {
	try {
		const activeSessions = await SessionManager.getAll();
		return c.json({
			message: "活躍 sessions 獲取成功",
			sessions: activeSessions,
			count: activeSessions.length
		});
	} catch (error) {
		console.error("獲取活躍 sessions 失敗:", error);
		return c.text("獲取活躍 sessions 失敗", 500);
	}
});

router.get("/users/search", authenticated, requireAdmin, async (c) => {
	const role = c.req.query("role"); // 'worker', 'employer', 'admin'
	const query = c.req.query("query");
	const type = c.req.query("type"); // 'name', 'email', 'id'
	const page = parseInt(c.req.query("page") || "1", 10);
	const limit = Math.max(1, Math.min(200, parseInt(c.req.query("limit") || "10", 10)));

	if (!role || !query || !type) {
		return c.text("Role, query, and type are required", 400);
	}

	const offset = (page - 1) * limit;
	let results;

	switch (role) {
		case "worker":
			{
				let whereClause;
				switch (type) {
					case "id":
						whereClause = eq(workers.workerId, query);
						break;
					case "name":
						whereClause = sql`concat(${workers.firstName}, ' ', ${workers.lastName}) ilike ${`%${query}%`}`;
						break;
					case "email":
						whereClause = sql`${workers.email} ilike ${`%${query}%`}`;
						break;
					default:
						return c.text("Invalid search type for worker", 400);
				}
				results = await dbClient.query.workers.findMany({
					where: whereClause,
					limit: limit + 1,
					offset: offset,
					columns : {
						password: false,
						fcmTokens: false,
					}
				});
			}
			break;
		case "employer":
			{
				let whereClause;
				switch (type) {
					case "id":
						whereClause = eq(employers.employerId, query);
						break;
					case "name":
						whereClause = sql`${employers.employerName} ilike ${`%${query}%`}`;
						break;
					case "email":
						whereClause = sql`${employers.email} ilike ${`%${query}%`}`;
							break;
					default:
						return c.text("Invalid search type for employer", 400);
				}
				results = await dbClient.query.employers.findMany({
					where: whereClause,
					limit: limit + 1,
					offset: offset,
					columns : {
						password: false,
						fcmTokens: false,
					}
				});
			}
			break;
		case "admin":
			{
				let whereClause;
				switch (type) {
					case "id":
						whereClause = eq(admins.adminId, query);
						break;
					case "email":
						whereClause = sql`${admins.email} ilike ${`%${query}%`}`;
						break;
					default:
						return c.text("Invalid search type for admin", 400);
				}
				results = await dbClient.query.admins.findMany({
					where: whereClause,
					limit: limit + 1,
					offset: offset,
					columns : {
						password: false
					}
				});
			}
			break;
		default:
			return c.text("Invalid role", 400);
	}

	const hasMore = results.length > limit;
	const returnedResults = results.slice(0, limit);

	return c.json({
    user: returnedResults,
    pagination: {
      limit,
      page,
      hasMore,
      returned: returnedResults.length,
    }
	});
});

router.put("/lock-worker/:workerId", authenticated, requireAdmin, async (c) => {
	const workerId = c.req.param("workerId");
	const worker = await dbClient.query.workers.findFirst({
		where: eq(workers.workerId, workerId),
	});

	if (!worker) {
		return c.text("Worker not found", 404);
	}

	if (worker.lockedUntil && worker.lockedUntil > new Date()) {
		return c.text("Worker account is already locked", 400);
	}

	const lockDurationDays = 30;
	const lockedUntil = new Date();
	lockedUntil.setDate(lockedUntil.getDate() + lockDurationDays);
	await dbClient
		.update(workers)
		.set({ lockedUntil: lockedUntil })
		.where(eq(workers.workerId, workerId));
	
	return c.text("Worker account has been locked", 200);
});

// 
router.put("/unlock-worker/:workerId", authenticated, requireAdmin, async (c) => {
	const workerId = c.req.param("workerId");
	const worker = await dbClient.query.workers.findFirst({
		where: eq(workers.workerId, workerId),
	});

	if (!worker) {
		return c.text("Worker not found", 404);
	}

	if (worker.lockedUntil === null) {
		return c.text("Worker account is not locked", 400);
	}

	await dbClient
		.update(workers)
		.set({ lockedUntil: null, absenceCount: 0 })
		.where(eq(workers.workerId, workerId));
	
	// 清除快取
	await UserCache.clearUserProfile(workerId, Role.WORKER);
	
	return c.text("Worker account has been unlocked", 200);
});

export default { path: "/admin", router } as IRouter;
