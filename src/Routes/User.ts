import { Router } from "@nhttp/nhttp";
import passport from "passport";
import { authenticated } from "../Middleware/middleware.ts";
import signature from "cookie-signature";
import type IRouter from "../Interfaces/IRouter.ts";
import dbClient from "../Client/DrizzleClient.ts";
import { eq, avg, count } from "drizzle-orm";
import { employers, workers, workerRatings, employerRatings } from "../Schema/DatabaseSchema.ts";
import { argon2Config } from "../config.ts";
import { hash as argon2hash, verify } from "@node-rs/argon2";
import validate from "@nhttp/zod";
import NotificationHelper from "../Utils/NotificationHelper.ts";
import {
  employerSignupSchema,
  workerSignupSchema,
  updateWorkerProfileSchema,
  updateEmployerProfileSchema,
  updatePasswordSchema,
} from "../Middleware/validator.ts";
import { uploadDocument, uploadProfilePhoto } from "../Middleware/uploadFile.ts";
import { Role } from "../Types/types.ts";
import { s3Client, generatePresignedUrl, cleanupTempFiles } from "../Utils/FileUtils.ts";

const router = new Router();

router.post(
  "/register/worker",
  validate(workerSignupSchema),
  async ({ headers, response, body }) => {
    const platform = headers.get("platform");
    if (!platform?.length) {
      return response.status(400).send("Platform is required");
    }
    const {
      email,
      password,
      firstName,
      lastName,
      phoneNumber,
      highestEducation = "大學",
      schoolName,
      major,
      studyStatus = "就讀中",
      certificates = [],
    } = body;

    const existingUser = await dbClient.query.workers.findFirst({
      where: eq(workers.email, email),
    });

    if (existingUser) {
      return response.status(409).send("User with this email already exists");
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
      })
      .returning();

    const newUser = insertedUsers[0];

    // 發送歡迎通知給新註冊的打工者
    await NotificationHelper.notifyUserWelcome(
      newUser.workerId,
      newUser.firstName,
      "worker"
    );

    return response.status(201).send({
      message: "User registered successfully:",
      user: {
        workerId: newUser.workerId,
        email: newUser.email,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
      },
    });
  },
);

router.post(
  "/register/employer",
  uploadDocument,
  validate(employerSignupSchema),
  async ({ headers, body, file: reqFile, response }) => {

    let files = null;
    if (body.identificationType === "businessNo" && reqFile.verficationDocument) {
      files = reqFile.verficationDocument.length === undefined ? [reqFile.verficationDocument] : reqFile.verficationDocument;
    } else if (body.identificationType === "personalId" && reqFile.identificationDocument) {
      files = reqFile.identificationDocument.length === undefined ? [reqFile.identificationDocument] : reqFile.identificationDocument;
    } else {
      return response.status(400).send("Invalid identification document");
    }

    try {
      const platform: string = headers.get("platform");
      if (platform === "web-employer") {
        const {
          email,
          password,
          employerName,
          branchName,
          industryType,
          address,
          phoneNumber,
          identificationType,
          identificationNumber,
          employerPhoto,
        } = body;

        const existing = await dbClient.query.employers.findFirst({
          where: eq(employers.email, email),
        });

        if (existing) {
          return response
            .status(409)
            .send("employer with this email already exists");
        }

        const filesInfo: {
          originalName: string;
          type: string;
          r2Name: string;
        }[] = files.map((
          file: { name: string; type: string; filename: string },
        ) => ({
          originalName: file.name as string,
          type: file.type as string,
          r2Name: file.filename as string,
        }));

        const hashedPassword = await argon2hash(password, argon2Config);

        await Promise.all(
          files.map(
            async (file: { path: string; filename: string; name: string }) => {
              const currentFile = Bun.file(file.path);
              if (!currentFile.exists()) {
                throw new Error(
                  `Verification document file not found: ${file.name}`,
                );
              }
              await s3Client.write(
                `documents/${identificationType}/${file.filename}`,
                currentFile,
              );
              console.log(`File ${file.name} uploaded successfully`);
            },
          ),
        );

        const insertedUsers = await dbClient
          .insert(employers)
          .values({
            email,
            password: hashedPassword,
            employerName,
            branchName,
            industryType,
            address,
            phoneNumber,
            identificationType,
            identificationNumber,
            verificationDocuments: JSON.stringify(filesInfo),
            employerPhoto,
          })
          .returning();

        const newUser = insertedUsers[0];

        // 發送歡迎通知給新註冊的商家
        await NotificationHelper.notifyUserWelcome(
          newUser.employerId,
          newUser.employerName,
          "employer"
        );

        return response.status(201).send({
          message: "User registered successfully:",
          user: {
            employerId: newUser.employerId,
            email: newUser.email,
            employerName: newUser.employerName,
          },
        });
      }
      return response.status(400).send("Invalid platform");
    } catch (error) {
      console.error("Error in register/employee:", error);
      return response.status(500).send("Internal server error");
    } finally {
      cleanupTempFiles(files);
    }
  },
);

router.post("/login", (rev, next) => {
  passport.authenticate("local", (error,user,info) => {
    if (error) return next(error);
    if (!user) {
      console.error("Authentication failed:", info);
      return rev.response.status(401).send(info?.message || "Authentication failed");
    }

    rev.logIn(user, (err) => {
      if (err) return next(err);

      rev.response.cookie(
        "connect.sid",
        `s:${signature.sign(rev.sessionID, process.env.SESSIONSECRET)}`
      );

      return rev.response.status(200).send({user});
    });
  })(rev, next);
});

router.get("/logout", ({ response, session }) => {
  session.destroy();
  return response.status(200).send("Logged out successfully");
});

router.get("/profile", authenticated, async ({ user, response }) => {
  if (user.role === Role.WORKER) {
    const { password, profilePhoto, ...workerData } = user;
    let photoUrlData = null;

    if (profilePhoto?.r2Name) {
      const url = await generatePresignedUrl(`profile-photos/workers/${profilePhoto.r2Name}`);
      if (url) {
        photoUrlData = {
          url: url,
          originalName: profilePhoto.originalName,
          type: profilePhoto.type,
        };
      } else {
        // Keep photoUrlData as null if URL generation fails
        console.warn(`Failed to generate presigned URL for worker ${user.workerId} photo ${profilePhoto.r2Name}`);
      }
    }
    
    const ratingStats = await dbClient
        .select({
          totalRatings: count(workerRatings.ratingId),
          averageRating: avg(workerRatings.ratingValue),
        })
        .from(workerRatings)
        .where(eq(workerRatings.workerId, user.workerId));

    return { 
      ...workerData, 
      profilePhoto: photoUrlData,
      ratingStats: {
        totalRatings: ratingStats[0]?.totalRatings || 0,
        averageRating: ratingStats[0]?.averageRating ? Number(ratingStats[0].averageRating) : 0,
      }
    };
  }

  if (user.role === Role.EMPLOYER) {
    const { password, employerPhoto, verificationDocuments, ...employerData } = user; // Exclude verificationDocuments for now
    let photoUrlData = null;

    if (employerPhoto?.r2Name) {
      const url = await generatePresignedUrl(`profile-photos/employers/${employerPhoto.r2Name}`);
      if (url) {
        photoUrlData = {
          url: url,
          originalName: employerPhoto.originalName,
          type: employerPhoto.type,
        };
      } else {
        // Keep photoUrlData as null if URL generation fails
        console.warn(`Failed to generate presigned URL for employer ${user.employerId} photo ${employerPhoto.r2Name}`);
      }
    }

    const ratingStats = await dbClient
        .select({
          totalRatings: count(employerRatings.ratingId),
          averageRating: avg(employerRatings.ratingValue),
        })
        .from(employerRatings)
        .where(eq(employerRatings.employerId, user.employerId));

    // Return verificationDocuments as is from the DB for this route; it's handled by another endpoint.
    return { 
      ...employerData, 
      employerPhoto: photoUrlData, 
      verificationDocuments,
      ratingStats: {
        totalRatings: ratingStats[0]?.totalRatings || 0,
        averageRating: ratingStats[0]?.averageRating ? Number(ratingStats[0].averageRating) : 0,
      }
    };
  }

  return response.status(400).send("Invalid role");
});

router.put("/update/profile", authenticated, async ({ body, response, request, user }) => {
  try {
    if (user.role === Role.WORKER) {
      const validationResult = updateWorkerProfileSchema.safeParse(body);

      if (!validationResult.success) {
        return response
          .status(400)
          .json({
            message: "Validation failed",
            errors: validationResult.error.flatten(),
          });
      }

      const validatedData = validationResult.data;

      const updatedWorker = await dbClient
        .update(workers)
        .set({ ...validatedData, updatedAt: new Date() })
        .where(eq(workers.workerId, user.workerId))
        .returning();

      const { password, ...workerData } = updatedWorker[0];
      return response.status(200).json(workerData);

    }
    if (user.role === Role.EMPLOYER) {
      const validationResult = updateEmployerProfileSchema.safeParse(body);

      if (!validationResult.success) {
        return response.status(400).json({
          message: "Validation failed",
          errors: validationResult.error.flatten(),
        });
      }

      const validatedData = validationResult.data;

      if(Object.keys(validatedData).length === 0) {
        return response.status(400).send("No valid data provided for update");
      }

      const updatedEmployer = await dbClient
        .update(employers)
        .set({ ...validatedData, updatedAt: new Date() })
        .where(eq(employers.employerId, user.employerId))
        .returning();

      if (updatedEmployer.length === 0) {
        return response.status(404).send("Employer not found");
      }

      const { password: empPassword, ...employerData } = updatedEmployer[0];
      return response.status(200).json(employerData);

    }
    return response.status(400).send("Invalid user role for profile update");
  } catch (error) {
    console.error("Error updating profile:", error);
    return response.status(500).send("Internal server error");
  }
});

//update password
router.put(
  "/update/password",
  authenticated,
  async ({ body, user, response }) => {
    try {
      const { currentPassword, newPassword } = body;

      if (!currentPassword || !newPassword) {
        return response.status(400).send("Current and new passwords are required");
      }

      if (currentPassword === newPassword) {
        return response.status(400).send("New password cannot be the same as current password");
      }

      if (!updatePasswordSchema.safeParse(body).success) {
        return response.status(400).json({
          message: "Validation failed",
          errors: updatePasswordSchema.safeParse(body).error.flatten(),
        });
      }

      if (user.role === Role.WORKER) {
        const worker = await dbClient.query.workers.findFirst({
          where: eq(workers.workerId, user.workerId),
        });

        if (!worker) {
          return response.status(404).send("Worker not found");
        }

        const passwordCorrect = await verify(worker.password, currentPassword, argon2Config);
        if (!passwordCorrect) {
          return response.status(401).send("Current password is incorrect");
        }

        const hashedNewPassword = await argon2hash(newPassword, argon2Config);

        await dbClient
          .update(workers)
          .set({ password: hashedNewPassword, updatedAt: new Date() })
          .where(eq(workers.workerId, user.workerId));

        return response.status(200).send("Password updated successfully");

      } else if (user.role === Role.EMPLOYER) {
        const employer = await dbClient.query.employers.findFirst({
          where: eq(employers.employerId, user.employerId),
        });

        if (!employer) {
          return response.status(404).send("Employer not found");
        }

        const passwordCorrect = await verify(employer.password, currentPassword, argon2Config);
        if (!passwordCorrect) {
          return response.status(401).send("Current password is incorrect");
        }

        const hashedNewPassword = await argon2hash(newPassword, argon2Config);

        await dbClient
          .update(employers)
          .set({ password: hashedNewPassword, updatedAt: new Date() })
          .where(eq(employers.employerId, user.employerId));

        return response.status(200).send("Password updated successfully");

      } else {
        return response.status(400).send("Invalid user role for password update");
      }
    } catch (error) {
      console.error("Error updating password:", error);
      return response.status(500).send("Internal server error");
    }
  }
)

router.put(
  "/update/identification",
  authenticated,
  uploadDocument,
  async ({ headers, body, file: reqFile, response, user }) => {
    let files = null;
    try {
      if (reqFile.length === 0) {
        return response.status(400).send("No file uploaded");
      }

      if (body.identificationType === "businessNo" && reqFile.verficationDocument) {
        files = reqFile.verficationDocument.length === undefined ? [reqFile.verficationDocument] : reqFile.verficationDocument;
      } else if (body.identificationType === "personalId" && reqFile.identificationDocument) {
        files = reqFile.identificationDocument.length === undefined ? [reqFile.identificationDocument] : reqFile.identificationDocument;
      } else {
        return response.status(400).send("Invalid identification document");
      }

      if (user.role === Role.EMPLOYER && headers.get("platform") === "web-employer") {
        const filesInfo: {
          originalName: string;
          type: string;
          r2Name: string;
        }[] = files.map((file: { name: string; type: string; filename: string }) => ({
          originalName: file.name as string,
          type: file.type as string,
          r2Name: file.filename as string,
        }));

        const deleteFiles = JSON.parse(user.verificationDocuments).map(
          (file: { r2Name: string }) =>
            s3Client.delete(`documents/${body.identificationType}/${file.r2Name}`)
        );

        await Promise.all(deleteFiles);

        await Promise.all(
          files.map(async (file: { path: string; filename: string; name: string }) => {
            const currentFile = Bun.file(file.path);
            if (!currentFile.exists()) {
              throw new Error(`Verification document file not found: ${file.name}`);
            }
            await s3Client.write(
              `documents/${body.identificationType}/${file.filename}`,
              currentFile,
            );
            console.log(`File ${file.name} uploaded successfully`);
          }),
        );

        await dbClient
          .update(employers)
          .set({
            identificationType: body.identificationType,
            identificationNumber: body.identificationNumber,
            verificationDocuments: JSON.stringify(filesInfo),
            updatedAt: new Date(),
          })
          .where(eq(employers.employerId, user.employerId));

        return response.status(200).send("Identification updated successfully");
      }
      return response.status(400).send("Invalid user role for identification update");
    }
    catch (error) {
      console.error("Error updating identification:", error);
      return response.status(500).send("Internal server error");
    }
    finally {
      cleanupTempFiles(files);
    }
  }
);

router.put(
  "/update/profilePhoto",
  authenticated,
  uploadProfilePhoto,
  async ({ headers, file: reqFile, user, response , body}) => {
    try {
     
      if (reqFile.profilePhoto === null || body.deleteProfilePhoto === "true") {
        if(user.employerPhoto == null)return response.status(200).send("No profile photo to delete");
        await s3Client.delete(`profile-photos/employers/${user.employerPhoto.r2Name}`);
        await dbClient
          .update(employers)
          .set({
            employerPhoto: null,
            updatedAt: new Date(),
          })
          .where(eq(employers.employerId, user.employerId));
        return response.status(200).send("Profile photo deleted successfully");
      }

      const filesInfo: {
        originalName: string;
        type: string;
        r2Name: string;
      } = {
        originalName: reqFile.profilePhoto.name,
        type: reqFile.profilePhoto.type,
        r2Name: reqFile.profilePhoto.filename,
      }

      if (user.role === "worker" && headers.get("platform") === "mobile") {
        if (reqFile.profilePhoto === null || body.deleteProfilePhoto === "true") {
          if (user.profilePhoto == null) return response.status(200).send("No profile photo to delete");
          await s3Client.delete(`profile-photos/workers/${user.profilePhoto.r2Name}`);
          await dbClient
            .update(workers)
            .set({
              profilePhoto: null,
              updatedAt: new Date(),
            })
            .where(eq(workers.workerId, user.workerId));
          return response.status(200).send("Profile photo deleted successfully");
        }
        
        if (user.profilePhoto?.r2Name) {
          await s3Client.delete(`profile-photos/workers/${user.profilePhoto.r2Name}`);
        }

        await s3Client.write(
          `profile-photos/workers/${filesInfo.r2Name}`,
          Bun.file(reqFile.profilePhoto.path),
        );

        await dbClient
          .update(workers)
          .set({
            profilePhoto: filesInfo,
            updatedAt: new Date(),
          })
          .where(eq(workers.workerId, user.workerId));

        return response.status(200).send("Profile photo updated successfully");

      }
      if (user.role === "employer" && headers.get("platform") === "web-employer") {
        if (reqFile.profilePhoto === null || body.deleteProfilePhoto === "true") {
          if (user.employerPhoto == null) return response.status(200).send("No profile photo to delete");
          await s3Client.delete(`profile-photos/employers/${user.employerPhoto.r2Name}`);
          await dbClient
            .update(employers)
            .set({
            employerPhoto: null,
            updatedAt: new Date(),
          })
          .where(eq(employers.employerId, user.employerId));
        return response.status(200).send("Profile photo deleted successfully");
      }
        if (user.employerPhoto?.r2Name) {
          await s3Client.delete(`profile-photos/employers/${user.employerPhoto.r2Name}`);
        }

        await s3Client.write(
          `profile-photos/employers/${filesInfo.r2Name}`,
          Bun.file(reqFile.profilePhoto.path),
        );

        await dbClient
          .update(employers)
          .set({
            employerPhoto: filesInfo,
            updatedAt: new Date(),
          })
          .where(eq(employers.employerId, user.employerId));

        return response.status(200).send("Profile photo updated successfully");
      }

      return response.status(400).send("Platform requiered or mismatch");
    } catch (error) {
      console.error("Error updating profile photo:", error);
      return response.status(500).send("Internal server error");
    } finally {
      if( reqFile.profilePhoto ){
        cleanupTempFiles([reqFile.profilePhoto]);
      }
    }
  }
);

router.get("/employer/verification-documents", authenticated, async ({ user, response }) => {
  if (!user || user.role !== "employer") {
    return response.status(403).send("Forbidden: Employer access required.");
  }

  const employer = user; // user object is the employer object from authenticated middleware

  if (!employer.verificationDocuments || typeof employer.verificationDocuments !== 'string') {
    console.log(`Employer ${employer.employerId} has no verification documents or format is incorrect.`);
    return response.status(200).json([]); // Return empty array if no documents
  }

  try {
    const documentsArray = JSON.parse(employer.verificationDocuments);
    if (!Array.isArray(documentsArray)) {
      console.error(`Error parsing verificationDocuments for employer ${employer.employerId}: Not an array.`);
      return response.status(500).send("Error processing verification documents.");
    }

    const documentsWithUrls = await Promise.all(
      documentsArray.map(async (doc: any) => {
        if (doc?.r2Name && employer.identificationType) {
          const filePath = `documents/${employer.identificationType}/${doc.r2Name}`;
          const url = await generatePresignedUrl(filePath);
          if (url) {
            return {
              originalName: doc.originalName,
              type: doc.type,
              url: url,
            };
          }
          console.warn(`Failed to generate presigned URL for document ${doc.r2Name} of employer ${employer.employerId}`);
          // Return the document without a URL if generation fails, or omit it
          return {
            originalName: doc.originalName,
            type: doc.type,
            url: null, // Explicitly set URL to null
            error: "Failed to generate URL for this document.",
          };

        }
        // If doc is malformed or r2Name is missing, filter it out or return with error
        return null;
      })
    );

    // Filter out any null entries that resulted from malformed doc objects
    const validDocuments = documentsWithUrls.filter(doc => doc !== null);

    return response.status(200).json(validDocuments);
  } catch (error) {
    console.error(`Error processing verification documents for employer ${employer.employerId}:`, error);
    return response.status(500).send("Internal server error while processing documents.");
  }
});

export default { path: "/user", router } as IRouter;