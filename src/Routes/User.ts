import { Hono } from "hono";
import type { HonoGenericContext } from "../Types/types";
import { zValidator } from "@hono/zod-validator";
import {
  loginSchema,
  workerSignupSchema,
  employerSignupSchema,
  updateWorkerProfileSchema,
  updateEmployerProfileSchema,
  updatePasswordSchema,
  passwordResetRequestSchema,
  passwordResetVerifySchema,
} from "../Types/zodSchema";
import { authenticate, authenticated, deserializeUser } from "../Middleware/authentication";
import { uploadDocument, uploadProfilePhoto } from "../Middleware/fileUpload";
import type IRouter from "../Interfaces/IRouter";
import dbClient from "../Client/DrizzleClient";
import { eq, avg, count, sql } from "drizzle-orm";
import { employers, workers, workerRatings, employerRatings } from "../Schema/DatabaseSchema";
import { argon2Config } from "../config";
import { hash as argon2hash, verify } from "@node-rs/argon2";
import { Role } from "../Types/types";
import { UserCache, FileManager, RatingCache, s3Client } from "../Client/Cache/Index";
import NotificationHelper from "../Utils/NotificationHelper";
import { requireEmployer } from "../Middleware/guards";
import { sendEmail } from "../Client/EmailClient";
import SessionManager from "../Utils/SessionManager";
import { PasswordResetManager } from "../Utils/PasswordResetManager";
import { EmailTemplates } from "../Utils/EmailTemplates";
import { LoginAttemptManager } from "../Utils/LoginAttemptManager";
import { getConnInfo } from 'hono/bun'

const router = new Hono<HonoGenericContext>();

// Worker Registration
router.post("/register/worker", zValidator("json", workerSignupSchema), async (c) => {
  if (c.get("session").get("id")) return c.text("已經登入", 401);

  const platform = c.req.header("platform");

  if (!platform?.length) {
    return c.text("Platform is required", 400);
  }

  const body = c.req.valid("json");
  const {
    email,
    password,
    firstName,
    lastName,
    phoneNumber,
    highestEducation = "其他",
    schoolName,
    major,
    studyStatus = "就讀中",
    certificates = [],
    jobExperience = [],
  } = body;

  const existingUser = await dbClient.query.workers.findFirst({
    where: eq(workers.email, email),
  });

  if (existingUser) {
    return c.text("User with this email already exists", 409);
  }

  const hashedPassword = await argon2hash(password, argon2Config);

  const insertedUsers = await dbClient
    .insert(workers)
    .values({
      email,
      password: hashedPassword,
      firstName,
      lastName,
      phoneNumber,
      highestEducation,
      schoolName,
      major,
      studyStatus,
      certificates,
      jobExperience,
    })
    .returning();

  const newUser = insertedUsers[0];

  // 發送歡迎[通知]給新註冊的打工者
  await NotificationHelper.notifyUserWelcome(newUser.workerId, newUser.firstName, "worker");

  // 發送歡迎[郵件]給新註冊的打工者
  const subject = "你好! 歡迎加入 WorkNow";
  const html = EmailTemplates.generateWorkerWelcomeEmail(firstName);
  await sendEmail(email, subject, html);

  return c.json(
    {
      message: "User registered successfully:",
      user: {
        workerId: newUser.workerId,
        email: newUser.email,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
      },
    },
    201
  );
});

// Employer Registration
router.post("/register/employer", uploadDocument, zValidator("form", employerSignupSchema), async (c) => {
  if (c.get("session").get("id")) return c.text("已經登入", 401);
  const uploadedFiles = c.get("uploadedFiles") as Record<string, any>;
  const body = c.req.valid("form");
  const fileType = (body.identificationType === "businessNo") ? "verificationDocuments" : "identificationDocuments";
  const files = uploadedFiles[fileType] || [];

  if (files.length === 0) {
    return c.text("No files uploaded for " + fileType, 400);
  }

  try {
    const platform = c.req.header("platform");
    if (platform === "web-employer") {
      const { email, password, employerName, branchName, industryType, address, phoneNumber, identificationType, identificationNumber } = body;

      const existing = await dbClient.query.employers.findFirst({
        where: eq(employers.email, email),
      });

      if (existing) {
        return c.text("employer with this email already exists", 409);
      }

      const filesInfo: {
        originalName: string;
        type: string;
        r2Name: string;
      }[] = files.map((file: { name: string; type: string; filename: string }) => ({
        originalName: file.name as string,
        type: file.type as string,
        r2Name: file.filename as string,
      }));

      const hashedPassword = await argon2hash(password, argon2Config);

      const insertedUsers = await dbClient
        .insert(employers)
        .values({
          email,
          password: hashedPassword,
          employerName,
          branchName,
          industryType: industryType as any, // Type assertion for enum
          address,
          phoneNumber,
          identificationType,
          identificationNumber,
          verificationDocuments: filesInfo,
          employerPhoto: null,
        })
        .returning();

      const newUser = insertedUsers[0];

      // 上傳身份證明文件到 S3
      await Promise.all(
        files.map(async (file: any) => {
          const key = `identification/${newUser.employerId}/${file.filename}`;
          await s3Client.file(key).write(file.file as Blob, { type: file.type });
          console.log(`File ${file.name} uploaded successfully`);
        })
      );

      // 發送歡迎[通知]給新註冊的商家
      await NotificationHelper.notifyUserWelcome(newUser.employerId, newUser.employerName, "employer");

      // 發送歡迎[郵件]給新註冊的商家
      const subject = "你好! 歡迎加入 WorkNow！";
      const html = EmailTemplates.generateEmployerWelcomeEmail(employerName);
      await sendEmail(email, subject, html);

      return c.json(
        {
          message: "User registered successfully:",
          user: {
            employerId: newUser.employerId,
            email: newUser.email,
            employerName: newUser.employerName,
          },
        },
        201
      );
    }
    return c.text("Invalid platform", 400);
  } catch (error) {
    console.error("Error in register/employee:", error);
    return c.text("Internal server error", 500);
  }
});

// delete user
router.delete("/delete", authenticated, async (c) => {
  const user = c.get("user");
  if (user.role === Role.WORKER) {
    await dbClient.delete(workers).where(eq(workers.workerId, user.workerId));
    await UserCache.clearUserProfile(user.workerId, Role.WORKER);
    return c.text("Worker account deleted successfully", 200);
  }
  if (user.role === Role.EMPLOYER) {
    await dbClient.delete(employers).where(eq(employers.employerId, user.employerId));
    await UserCache.clearUserProfile(user.employerId, Role.EMPLOYER);
    return c.text("Employer account deleted successfully", 200);
  }
  return c.text("Invalid user role for deletion", 400);
});

router.post("/login", zValidator("json", loginSchema), authenticate, async (c) => {
  // 認證成功後，獲取用戶資料
  const session = c.get("session");
  const user = await deserializeUser(session);

  if (!user) {
    return c.text("登入失敗", 401);
  }

  return c.json({
    message: "登入成功",
    user: {
      id: user.userId,
      role: user.role,
      email: user.email,
      ...(user.role === Role.WORKER ? {
        firstName: user.firstName,
        lastName: user.lastName
      } : {
        employerName: user.employerName
      })
    }
  });
});

router.get("/logout", async (c) => {
  const session = c.get("session");
  const userId = session.get("id");
  const role = session.get("role");

  // 檢查是否已經登出
  if (!userId) {
    return c.text("已經登出或沒有活動會話", 400);
  }

  // 清除用戶快取
  await UserCache.clearUserProfile(userId, role);

  // 清除 session 追蹤記錄
  await SessionManager.clear(userId);

  // 刪除會話
  session.deleteSession();
  return c.text("Logged out successfully");
});

// Get User Profile
router.get("/profile", authenticated, async (c) => {
  const user = c.get("user");

  if (user.role === Role.WORKER) {
    const { password, profilePhoto, ...workerData } = user;
    let photoUrlData = null;

    // 檢查 profilePhoto 是否存在且有 r2Name
    if (profilePhoto && typeof profilePhoto === 'object' && profilePhoto.r2Name) {
      const url = await FileManager.getPresignedUrl(`profile-photos/workers/${profilePhoto.r2Name}`);
      if (url) {
        photoUrlData = {
          url: url,
          originalName: profilePhoto.originalName,
          type: profilePhoto.type,
        };
      }
    }

    let ratingStats = await RatingCache.getRatingStats(user.workerId, Role.WORKER);

    if (!ratingStats) {
      const dbRatingStats = await dbClient
        .select({
          totalRatings: count(workerRatings.ratingId),
          averageRating: avg(workerRatings.ratingValue),
        })
        .from(workerRatings)
        .where(eq(workerRatings.workerId, user.workerId));

      ratingStats = {
        totalRatings: dbRatingStats[0]?.totalRatings || 0,
        averageRating: dbRatingStats[0]?.averageRating ? Number(dbRatingStats[0].averageRating) : 0,
      };

      await RatingCache.setRatingStats(user.workerId, Role.WORKER, ratingStats);
    }

    return c.json({
      ...workerData,
      profilePhoto: photoUrlData,
      ratingStats,
    });
  }

  if (user.role === Role.EMPLOYER) {
    const { password, employerPhoto, verificationDocuments, ...employerData } = user;
    let photoUrlData = null;

    // 檢查 employerPhoto 是否存在且有 r2Name
    if (employerPhoto && typeof employerPhoto === 'object' && employerPhoto.r2Name) {
      const url = await FileManager.getPresignedUrl(`profile-photos/employers/${employerPhoto.r2Name}`);
      if (url) {
        photoUrlData = {
          url: url,
          originalName: employerPhoto.originalName,
          type: employerPhoto.type,
        };
      }
    }

    let documentsWithUrls = [];

    if (user.verificationDocuments && Array.isArray(user.verificationDocuments)) {
      documentsWithUrls = await Promise.all(
        user.verificationDocuments.map(async (doc: any, index: number) => {
          if (!doc || !doc.r2Name) {
            console.warn(`驗證文件 ${index} 缺少 r2Name 屬性:`, doc);
            return {
              ...doc,
              presignedUrl: null,
              error: "文件資料不完整"
            };
          }

          const presignedUrl = await FileManager.getPresignedUrl(`identification/${user.userId}/${doc.r2Name}`);

          if (presignedUrl) {
            return { ...doc, presignedUrl };
          } else {
            console.warn(`驗證文件 URL 生成失敗: ${doc.r2Name}`);
            return {
              ...doc,
              presignedUrl: null,
              error: "URL 生成失敗"
            };
          }
        })
      );
    } else {
      console.log(`Employer ${user.userId} 沒有驗證文件或格式不正確`);
    }

    let ratingStats = await RatingCache.getRatingStats(user.employerId, Role.EMPLOYER);

    if (!ratingStats) {
      const dbRatingStats = await dbClient
        .select({
          totalRatings: count(employerRatings.ratingId),
          averageRating: avg(employerRatings.ratingValue),
        })
        .from(employerRatings)
        .where(eq(employerRatings.employerId, user.employerId));

      ratingStats = {
        totalRatings: dbRatingStats[0]?.totalRatings || 0,
        averageRating: dbRatingStats[0]?.averageRating ? Number(dbRatingStats[0].averageRating) : 0,
      };

      await RatingCache.setRatingStats(user.employerId, Role.EMPLOYER, ratingStats);
    }

    return c.json({
      ...employerData,
      employerPhoto: photoUrlData,
      verificationDocuments: documentsWithUrls,
      ratingStats,
    });
  }

  if (user.role === Role.ADMIN) {
    const { password, ...adminData } = user;
    return c.json(adminData);
  }

  return c.text("Invalid role", 400);
});

// Update Profile
router.put("/update/profile", authenticated, async (c) => {
  try {
    const user = c.get("user");
    const body = await c.req.json();

    if (user.role === Role.WORKER) {
      const validationResult = updateWorkerProfileSchema.safeParse(body);

      if (!validationResult.success) {
        return c.json(
          {
            message: "Validation failed",
            errors: validationResult.error.issues,
          },
          400
        );
      }

      const validatedData = validationResult.data;

      const updatedWorker = await dbClient
        .update(workers)
        .set({ ...validatedData, updatedAt: sql`now()` })
        .where(eq(workers.workerId, user.workerId))
        .returning();

      const { password, ...workerData } = updatedWorker[0];
      await UserCache.clearUserProfile(user.workerId, Role.WORKER);
      return c.json(workerData);
    }

    if (user.role === Role.EMPLOYER) {
      const validationResult = updateEmployerProfileSchema.safeParse(body);

      if (!validationResult.success) {
        return c.json(
          {
            message: "Validation failed",
            errors: validationResult.error.issues,
          },
          400
        );
      }

      const validatedData = validationResult.data;

      if (Object.keys(validatedData).length === 0) {
        return c.text("No valid data provided for update", 400);
      }

      const updatedEmployer = await dbClient
        .update(employers)
        .set({ ...validatedData, updatedAt: sql`now()` })
        .where(eq(employers.employerId, user.employerId))
        .returning();

      if (updatedEmployer.length === 0) {
        return c.text("Employer not found", 404);
      }

      const { password: empPassword, ...employerData } = updatedEmployer[0];
      await UserCache.clearUserProfile(user.employerId, Role.EMPLOYER);
      return c.json(employerData);
    }

    return c.text("Invalid user role for profile update", 400);
  } catch (error) {
    console.error("Error updating profile:", error);
    return c.text("Internal server error", 500);
  }
});

// Update Password
router.put("/update/password", authenticated, async (c) => {
  try {
    const user = c.get("user");
    const bodyJson = await c.req.json();
    const validation = updatePasswordSchema.safeParse(bodyJson);
    if (!validation.success) {
      return c.json(
        {
          message: "Validation failed",
          errors: validation.error.issues,
        },
        400
      );
    }

    const { currentPassword, newPassword } = validation.data;

    if (!currentPassword || !newPassword) {
      return c.text("Current and new passwords are required", 400);
    }

    if (currentPassword === newPassword) {
      return c.text("New password cannot be the same as current password", 400);
    }

    if (user.role === Role.WORKER) {
      const worker = await dbClient.query.workers.findFirst({
        where: eq(workers.workerId, user.workerId),
      });

      if (!worker) {
        return c.text("Worker not found", 404);
      }

      const passwordCorrect = await verify(worker.password, currentPassword, argon2Config);
      if (!passwordCorrect) {
        return c.text("Current password is incorrect", 401);
      }

      const hashedNewPassword = await argon2hash(newPassword, argon2Config);

      await dbClient.update(workers).set({ password: hashedNewPassword, updatedAt: sql`now()` }).where(eq(workers.workerId, user.workerId));

      return c.text("Password updated successfully");
    }
    if (user.role === Role.EMPLOYER) {
      const employer = await dbClient.query.employers.findFirst({
        where: eq(employers.employerId, user.employerId),
      });

      if (!employer) {
        return c.text("Employer not found", 404);
      }

      const passwordCorrect = await verify(employer.password, currentPassword, argon2Config);
      if (!passwordCorrect) {
        return c.text("Current password is incorrect", 401);
      }

      const hashedNewPassword = await argon2hash(newPassword, argon2Config);

      await dbClient.update(employers).set({ password: hashedNewPassword, updatedAt: sql`now()` }).where(eq(employers.employerId, user.employerId));

      return c.text("Password updated successfully");
    }
    return c.text("Invalid user role for password update", 400);
  } catch (error) {
    console.error("Error updating password:", error);
    return c.text("Internal server error", 500);
  }
});

// Update Identification Documents
router.put("/update/identification", authenticated, requireEmployer, uploadDocument, async (c) => {
  const user = c.get("user");
  const uploadedFilesObj = c.get("uploadedFiles") as Record<string, any>;
  const body = await c.req.parseBody();
  const files = uploadedFilesObj[(body.identificationType === "businessNo") ? "verificationDocuments" : "identificationDocuments"] || [];

  try {
    if (user.approvalStatus === "approved") {
      return c.text("Approved employers cannot update identification documents", 400);
    }

    if (files.length === 0) {
      return c.text("No files uploaded for verification", 400);
    }

    if (body.identificationType !== "businessNo" && body.identificationType !== "personalId") {
      return c.text("Invalid identification type", 400);
    }

    if (typeof body.identificationNumber !== "string" || body.identificationNumber.length === 0) {
      return c.text("Invalid identification number", 400);
    }

    const uploadDBFiles = files.map((file: { filename: string; name: string; type: string }) => ({
      originalName: file.name as string,
      type: file.type as string,
      r2Name: file.filename as string
    }));

    await Promise.all(
      files.map(async (file: any) => {
        const key = `identification/${user.userId}/${file.filename}`;
        await s3Client.file(key).write(file.file as Blob, { type: file.type });
      })
    );

    if (user.verificationDocuments && user.verificationDocuments.length > 0) {
      await Promise.all(
        user.verificationDocuments.map(async (doc: { r2Name: string }) => {
          await s3Client.delete(`identification/${user.userId}/${doc.r2Name}`);
        })
      );
    }

    await dbClient
      .update(employers)
      .set({
        identificationType: body.identificationType,
        identificationNumber: body.identificationNumber,
        verificationDocuments: uploadDBFiles,
        approvalStatus: "pending",
        updatedAt: sql`now()`,
      })
      .where(eq(employers.employerId, user.employerId));

    return c.text("verification documents updated successfully", 200);
  }
  catch (error) {
    console.error("Error updating identification documents:", error);
    return c.text("Internal server error", 500);
  }
  finally {
    await UserCache.clearUserProfile(user.employerId, Role.EMPLOYER);
  }
});

// Update Profile Photo
router.put("/update/profilePhoto", authenticated, uploadProfilePhoto, async (c) => {
  const user = c.get("user");
  const uploadedFilesObj = c.get("uploadedFiles") as Record<string, any>;
  const body = await c.req.parseBody();
  const photoFile = uploadedFilesObj.profilePhoto as any | null;
  const isDelete = String(body.deleteProfilePhoto) === "true";
  if (!photoFile && !isDelete) return c.text("No profile photo uploaded", 400);

  try {
    if (isDelete) {
      if (user.role === Role.WORKER) {
        if (!user.profilePhoto?.r2Name) return c.text("No profile photo to delete", 200);
        await s3Client.delete(`profile-photos/workers/${user.profilePhoto.r2Name}`);
        await dbClient
          .update(workers)
          .set({ profilePhoto: null, updatedAt: sql`now()` })
          .where(eq(workers.workerId, user.userId));
        return c.text("worker profile photo deleted", 200);
      }

      if (user.role === Role.EMPLOYER) {
        if (!user.employerPhoto?.r2Name) return c.text("No profile photo to delete", 200);
        await s3Client.delete(`profile-photos/employers/${user.employerPhoto.r2Name}`);
        await dbClient
          .update(employers)
          .set({ employerPhoto: null, updatedAt: sql`now()` })
          .where(eq(employers.employerId, user.employerId));
        return c.text("employer profile photo deleted", 200);
      }

      return c.text("invalid role", 400);
    }

    const photoData = {
      originalName: photoFile.name as string,
      type: photoFile.type as string,
      r2Name: photoFile.filename as string,
    };

    if (user.role === Role.WORKER) {
      if (user.profilePhoto?.r2Name) await s3Client.delete(`profile-photos/workers/${user.profilePhoto.r2Name}`);
      await s3Client.file(`profile-photos/workers/${photoFile.filename}`).write(photoFile.file as Blob, { type: photoFile.type });

      await dbClient
        .update(workers)
        .set({
          profilePhoto: photoData,
          updatedAt: sql`now()`,
        })
        .where(eq(workers.workerId, user.userId));
      return c.text("worker profile photo updated successfully", 200);

    } 
    if (user.role === Role.EMPLOYER) {
      if (user.employerPhoto?.r2Name) await s3Client.delete(`profile-photos/employers/${user.employerPhoto.r2Name}`);
      await s3Client.file(`profile-photos/employers/${photoFile.filename}`).write(photoFile.file as Blob, { type: photoFile.type });

      await dbClient
        .update(employers)
        .set({
          employerPhoto: photoData,
          updatedAt: sql`now()`,
        })
        .where(eq(employers.employerId, user.employerId));

      return c.text("employer profile photo updated successfully", 200);
    }
    return c.text("invalid role", 400);
  } catch (error) {
    console.error("更新個人照片時出錯:", error);
    return c.text("伺服器內部錯誤", 500);
  } finally {
    if (user.role === Role.WORKER) {
      await UserCache.clearUserProfile(user.workerId, Role.WORKER);
    } else if (user.role === Role.EMPLOYER) {
      await UserCache.clearUserProfile(user.employerId, Role.EMPLOYER);
    }
  }
});

// Password Reset Request
router.post("/pw-reset/request", zValidator("json", passwordResetRequestSchema), async (c) => {
  try {
    const { email } = c.req.valid("json");
    const platform = c.req.header("platform");

    if (!platform?.length) {
      return c.text("Platform is required", 400);
    }

    if (platform !== "mobile" && platform !== "web-employer") {
      return c.text("Invalid platform", 400);
    }

    let userExists = null;

    if (platform === "mobile") {
      userExists = await dbClient.query.workers.findFirst({ where: eq(workers.email, email) });
    } else if (platform === "web-employer") {
      userExists = await dbClient.query.employers.findFirst({ where: eq(employers.email, email) });
    }

    const resetStatus = await PasswordResetManager.getResetStatus(email);

    if (!resetStatus.canRequestNew) {
      return c.text(`請等待 ${resetStatus.remainingCooldownTime} 秒後再重新請求`, 429);
    }

    if (userExists) {
      const verificationCode = await PasswordResetManager.storeVerificationCode(email);
      const subject = "WorkNow 密碼重設驗證碼";
      const html = EmailTemplates.generatePasswordResetEmail(verificationCode, 30);
      await sendEmail(email, subject, html);
    } else {
      await PasswordResetManager.setRequestCooldown(email);
    }

    return c.text("如果該郵箱地址存在於我們的系統中，您將會收到密碼重設驗證碼", 200);
  } catch (error) {
    console.error("Password reset request error:", error);
    return c.text("處理密碼重設請求時發生錯誤", 500);
  }
});

// Password Reset Verify and Update
router.post("/pw-reset/verify", zValidator("json", passwordResetVerifySchema), async (c) => {
  try {
    const { email, verificationCode, newPassword } = c.req.valid("json");
    const platform = c.req.header("platform");

    if (!platform?.length) {
      return c.text("Platform is required", 400);
    }

    if (platform !== "mobile" && platform !== "web-employer") {
      return c.text("Invalid platform", 400);
    }

    const isValidCode = await PasswordResetManager.verifyCode(email, verificationCode);

    if (!isValidCode) {
      return c.text("驗證碼無效或已過期", 400);
    }

    let userExists = null;

    if (platform === "mobile") {
      userExists = await dbClient.query.workers.findFirst({ where: eq(workers.email, email) });
    } else if (platform === "web-employer") {
      userExists = await dbClient.query.employers.findFirst({ where: eq(employers.email, email) });
    }

    if (!userExists) {
      return c.text("用戶不存在", 404);
    }

    const hashedPassword = await argon2hash(newPassword, argon2Config);

    if (platform === "mobile") {
      await dbClient
        .update(workers)
        .set({ password: hashedPassword, updatedAt: sql`now()` })
        .where(eq(workers.workerId, userExists.workerId));

      await UserCache.clearUserProfile(userExists.workerId, Role.WORKER);
    } else if (platform === "web-employer") {
      await dbClient
        .update(employers)
        .set({ password: hashedPassword, updatedAt: sql`now()` })
        .where(eq(employers.employerId, userExists.employerId));

      await UserCache.clearUserProfile(userExists.employerId, Role.EMPLOYER);
    }

    const info = getConnInfo(c)
    const clientIP = info.remote.address
    console.log(clientIP);

    const subject = "WorkNow 密碼重設成功通知";
    const html = EmailTemplates.generatePasswordResetSuccessEmail();
    await sendEmail(email, subject, html);
    await PasswordResetManager.deleteVerificationCode(email);
    await LoginAttemptManager.clearFailedAttempts(platform, email, clientIP);
    return c.text("密碼重設成功", 200);
  } catch (error) {
    console.error("Password reset verify error:", error);
    return c.text("處理密碼重設時發生錯誤", 500);
  }
});

export default { path: "/user", router } as IRouter;
