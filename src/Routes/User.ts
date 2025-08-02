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
} from "../Types/zodSchema";
import { authenticate, authenticated, deserializeUser } from "../Middleware/authentication";
import { uploadDocument, uploadProfilePhoto } from "../Middleware/fileUpload";
import type IRouter from "../Interfaces/IRouter";
import dbClient from "../Client/DrizzleClient";
import { eq, avg, count } from "drizzle-orm";
import { employers, workers, workerRatings, employerRatings } from "../Schema/DatabaseSchema";
import { argon2Config } from "../config";
import { hash as argon2hash, verify } from "@node-rs/argon2";
import { Role } from "../Types/types";
import { UserCache, FileManager, RatingCache, s3Client } from "../Client/Cache/Index";
import NotificationHelper from "../Utils/NotificationHelper";
import { requireEmployer } from "../Middleware/guards";
import { promise } from "zod";

const router = new Hono<HonoGenericContext>();

// Worker Registration
router.post("/register/worker", zValidator("form", workerSignupSchema), async (c) => {
  const platform = c.req.header("platform");
  if (!platform?.length) {
    return c.text("Platform is required", 400);
  }

  const body = c.req.valid("form");
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

  // 發送歡迎通知給新註冊的打工者
  await NotificationHelper.notifyUserWelcome(newUser.workerId, newUser.firstName, "worker");

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
  const uploadedFiles = c.get("uploadedFiles") as any[];
  const body = c.req.valid("form");
  const fileType = (body.identificationType === "businessNo") ? "verficationDocument" : "identificationDocument";
  const files = uploadedFiles[fileType] || [];

  if(files.length === 0) {
    return c.text("No files uploaded for verification", 400);
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

      // 上傳身份證明文件到 S3
      await Promise.all(
        files.map(async (file: { path: string; filename: string; name: string }) => {
          const currentFile = Bun.file(file.path);
          if (!(await currentFile.exists())) {
            throw new Error(`Verification document file not found: ${file.name}`);
          }
          await s3Client.write(
            `documents/${identificationType}/${file.filename}`,
            currentFile,
          );
          console.log(`File ${file.name} uploaded successfully`);
        })
      );

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
          verificationDocuments: JSON.stringify(filesInfo),
          employerPhoto: null,
        })
        .returning();

      const newUser = insertedUsers[0];

      // 發送歡迎通知給新註冊的商家
      await NotificationHelper.notifyUserWelcome(newUser.employerId, newUser.employerName, "employer");

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
  } finally {
    // 清理臨時文件
    FileManager.cleanupTempFiles(files);
  }
});

// delete user
router.delete("/delete", authenticated, async (c) => {
  const user = c.get("user");
  if (user.role === Role.WORKER) {
    await dbClient.delete(workers).where(eq(workers.workerId, user.workerId));
    await UserCache.clearUserProfile(user.workerId, Role.WORKER);
    return c.text("Worker account deleted successfully", 200);
  } else if (user.role === Role.EMPLOYER) {
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

  // 檢查是否已經登出
  if (!session || !session.get("id")) {
    return c.text("已經登出或沒有活動會話", 400);
  }

  // 獲取用戶信息用於清除快取
  const userId = session.get("id");
  const role = session.get("role");

  // 清除用戶快取
  if (userId && role) {
    await UserCache.clearUserProfile(userId, role);
  }

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

      const ratingStats = {
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
            console.warn(`❌ 驗證文件 URL 生成失敗: ${doc.r2Name}`);
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

      const ratingStats = {
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
        .set({ ...validatedData, updatedAt: new Date() })
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
        .set({ ...validatedData, updatedAt: new Date() })
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
    const body = await c.req.json();
    const { currentPassword, newPassword } = body;

    if (!currentPassword || !newPassword) {
      return c.text("Current and new passwords are required", 400);
    }

    if (currentPassword === newPassword) {
      return c.text("New password cannot be the same as current password", 400);
    }

    const validation = updatePasswordSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        {
          message: "Validation failed",
          errors: validation.error.issues,
        },
        400
      );
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

      await dbClient.update(workers).set({ password: hashedNewPassword, updatedAt: new Date() }).where(eq(workers.workerId, user.workerId));

      return c.text("Password updated successfully");
    } else if (user.role === Role.EMPLOYER) {
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

      await dbClient.update(employers).set({ password: hashedNewPassword, updatedAt: new Date() }).where(eq(employers.employerId, user.employerId));

      return c.text("Password updated successfully");
    } else {
      return c.text("Invalid user role for password update", 400);
    }
  } catch (error) {
    console.error("Error updating password:", error);
    return c.text("Internal server error", 500);
  }
});

// Update Identification Documents
router.put("/update/identification", authenticated, uploadDocument, async (c) => {
  const user = c.get("user");
  const uploadedFilesObj = c.get("uploadedFiles") as Record<string, any>;
  const body = await c.req.parseBody();
  const files = uploadedFilesObj[(body.identificationType === "businessNo") ? "verficationDocument" : "identificationDocument"] || [];

  try {
    if (files.length === 0) {
      return c.text("No files uploaded for verification", 400);
    }

    if (body.identificationType !== "businessNo" && body.identificationType !== "personalId") {
      return c.text("Invalid identification type", 400);
    }

    if (typeof body.identificationNumber !== "string" || body.identificationNumber.length === 0) {
      return c.text("Invalid identification number", 400);
    }

    if (user.role === Role.EMPLOYER) {
      const uploadDBFiles = files.map((file: {filename: string; name: string; type: string }) => ({
        originalName: file.name as string,
        type: file.type as string,
        r2Name: file.filename as string
      }));

      await Promise.all(
        files.map(async (file: { path: string; filename: string; }) => {
          const currentFile = Bun.file(file.path);
          await s3Client.write(`identification/${user.userId}/${file.filename}`, currentFile);
        })
      ); 

      if(user.verificationDocuments && user.verificationDocuments.length > 0) {
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
          updatedAt: new Date(),
        })
        .where(eq(employers.employerId, user.employerId));

      return c.text("verification documents updated successfully", 200);
    }

    return c.text("Only employers can update identification documents", 403);
  } finally {
    // 清理臨時文件
    if (files.length > 0) FileManager.cleanupTempFiles(files);
    await UserCache.clearUserProfile(user.employerId, Role.EMPLOYER);
    
  }
});

// Update Profile Photo
router.put("/update/profilePhoto", authenticated, uploadProfilePhoto, async (c) => {
  
  const user = c.get("user");
  const uploadedFilesObj = c.get("uploadedFiles") as Record<string, any>;
  const body = await c.req.parseBody();
  
  const photoFile = uploadedFilesObj.profilePhoto;
  const photoData = {
    originalName: photoFile.name,
    type: photoFile.type,
    r2Name: photoFile.filename,
  };

  try {
    if (photoFile.length == 0 && body.deleteProfilePhoto == "true") {
      if (user.employerPhoto == null) return c.text("No profile photo to delete", 200);
      await s3Client.delete(`profile-photos/${user.role}s/${user.employerPhoto.r2Name}`);
      await dbClient
        .update(employers)
        .set({
          employerPhoto: null,
          updatedAt: new Date(),
        })
        .where(eq(employers.employerId, user.employerId));
      return c.text("個人照片已刪除", 200);
    }

    const currentFile = Bun.file(photoFile.path);

    if (user.role == Role.WORKER) {
      await s3Client.delete(`profile-photos/workers/${user.profilePhoto.r2Name}`);
      await s3Client.write(`profile-photos/workers/${photoFile.filename}`, currentFile);
      await dbClient
        .update(workers)
        .set({
          profilePhoto: {
            originalName: photoData.originalName,
            type: photoData.type,
            r2Name: photoData.r2Name,
          },
          updatedAt: new Date(),
        })
        .where(eq(workers.workerId, user.userId));
      return c.text("worker profile photo updated successfully", 200);

    } else if (user.role == Role.EMPLOYER) {
      if (user.employerPhoto != null){await s3Client.delete(`profile-photos/employers/${user.employerPhoto.r2Name}`);}
      await s3Client.write(`profile-photos/employers/${photoFile.filename}`, currentFile);
      
      await dbClient
        .update(employers)
        .set({
          employerPhoto: photoData,
          updatedAt: new Date(),
        })
        .where(eq(employers.employerId, user.employerId));
      
      return c.text("employer profile photo updated successfully", 200);
    }
    return c.text("invalid role", 400);
  } catch (error) {
    console.error("更新個人照片時出錯:", error);
    return c.text("伺服器內部錯誤", 500);
  } finally {
    if (photoFile.length > 0) FileManager.cleanupTempFiles([photoFile]);
    await UserCache.clearUserProfile(user.employerId, Role.EMPLOYER);
  }
});

export default { path: "/user", router } as IRouter;
