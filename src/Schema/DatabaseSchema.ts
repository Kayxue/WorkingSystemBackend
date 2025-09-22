import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  json,
  date,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { nanoid } from "nanoid";

// ========== 1. 打工者表（Workers） ==========
export const workers = pgTable("workers", {
  workerId: varchar("worker_id", { length: 21 })
    .$defaultFn(() => nanoid())
    .primaryKey(),

  email: text("email").notNull().unique(),
  password: text("password").notNull(),

  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  phoneNumber: text("phone_number"),

  profilePhoto: json("profile_photo").default([]), 

  // === 新增：學歷資訊 ===
  highestEducation: varchar("highest_education", {
    // 依需求可調整枚舉內容，如 "高中", "大專", "大學", "碩士", "博士", "其他"
    enum: ["高中", "大學", "碩士", "博士", "其他"],
  }).default("其他"),
  schoolName: text("school_name"), // 學校名稱
  major: text("major"), // 就讀科系
  studyStatus: varchar("study_status", {
    // 就讀中 / 已畢業 / 肄業等
    enum: ["就讀中", "已畢業", "肄業"],
  }).default("就讀中"),

  // 持有證書（可能有多張，用 JSON 陣列存放）
  certificates: json("certificates"),

  jobExperience: json("job_experience").default([]),

  // === FCM 推播通知相關欄位 ===
  fcmTokens: json("fcm_tokens").default([]), // 存儲多個 FCM tokens

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ========== 2. 商家表（Employers） ==========
// - 加入公司審核、證明文件圖檔、行業別、商家大頭照等欄位
export const employers = pgTable("employers", {
  employerId: varchar("employer_id", { length: 21 })
    .$defaultFn(() => nanoid())
    .primaryKey(),

  email: text("email").notNull().unique(),
  password: text("password").notNull(),

  // 商家名稱 (主畫面顯示)
  employerName: text("employer_name").notNull(),

  // 分店名稱或其他分支資訊 (可選)
  branchName: text("branch_name"),

  // 行業別(單選)，示範枚舉
  industryType: varchar("industry_type", {
    enum: ["餐飲", "批發/零售", "倉儲運輸", "展場活動", "其他"],
  }).default("其他"),

  // 商家地址
  address: text("address"),

  phoneNumber: text("phone_number"),

  // === 公司審核所需欄位 ===
  // 1) 驗證狀態 (eg. pending / approved / rejected)
  approvalStatus: varchar("approval_status", {
    enum: ["pending", "approved", "rejected"],
  })
    .default("pending")
    .notNull(),

  // 2) 身分類型：統一編號或身分證字號
  identificationType: varchar("identification_type", {
    enum: ["businessNo", "personalId"],
  })
    .default("businessNo")
    .notNull(),

  // 3) 統一編號／身分證字號
  identificationNumber: varchar("identification_number", { length: 50 }),

  // 4) 證明文件上傳，可存多張圖檔路徑
  verificationDocuments: json("verification_documents"), // e.g. ["https://...","https://..."]

  // 5) 商家大頭照
  employerPhoto: json("employer_photo"),

  // === FCM 推播通知相關欄位 ===
  fcmTokens: json("fcm_tokens").default([]), // 存儲多個 FCM tokens
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const admins = pgTable("admins", {
  adminId: varchar("admin_id", { length: 21 })
    .$defaultFn(() => nanoid())
    .primaryKey(),

  email: text("email").notNull().unique(),
  password: text("password").notNull(),

  // === FCM 推播通知相關欄位 ===
  fcmTokens: json("fcm_tokens").default([]), // 存儲多個 FCM tokens
});

// ========== 3. 工作表（Gigs） ==========
export const gigs = pgTable("gigs", {
  // 工作ID
  gigId: varchar("gig_id", { length: 21 })
    .$defaultFn(() => nanoid())
    .primaryKey(),

  // 商家ID
  employerId: varchar("employer_id", { length: 21 })
    .notNull()
    .references(() => employers.employerId, { onDelete: "cascade" }),

  // 工作標題
  title: text("title").notNull(),
  // 工作描述
  description: text("description").notNull(), // 時薪等

  // 工作日期
  dateStart: date("date_start").notNull(),
  dateEnd: date("date_end").notNull(),
  // 工作時間
  timeStart: varchar("time_start", { length: 20 }).notNull(),
  timeEnd: varchar("time_end", { length: 20 }).notNull(),
  // 工作需求
  requirements: json("requirements").default([]),

  // 時薪
  hourlyRate: integer("hourly_rate").notNull(),
  // 城市
  city: varchar("city", { length: 32 }).notNull(),
  // 地區
  district: varchar("district", { length: 32 }).notNull(),
  // 地址
  address: varchar("address", { length: 256 }).notNull(),

  // 打工環境照上傳，可存多張圖檔路徑
  environmentPhotos: json("environment_photos").default([]),

  // 聯絡人
  contactPerson: varchar("contact_person", { length: 32 }).notNull(),
  // 聯絡人電話
  contactPhone: varchar("contact_phone", { length: 32 }),
  // 聯絡人Email
  contactEmail: varchar("contact_email", { length: 128 }),

  // 工作是否進行中 (true: 進行中, false: 已結束)
  isActive: boolean("is_active").default(true),

  // 刊登時間
  publishedAt: date("published_at").notNull(),
  // 下架時間
  unlistedAt: date("unlisted_at"),

  // 工作ID建立時間
  createdAt: timestamp("created_at").defaultNow(),
  // 工作ID更新時間
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  // PGroonga 索引：title
  index("pgroonga_gigs_index")
    .using("pgroonga", t.title)
    .with({ tokenizer: "'TokenBigramSplitSymbol'" }),
  // PGroonga 索引：description
  index("pgroonga2_gigs_index")
    .using("pgroonga", t.description)
    .with({ tokenizer: "'TokenBigramSplitSymbol'" }),
]);

// ========== 4. 工作申請表（GigApplications） ==========
export const gigApplications = pgTable(
  "gig_applications",
  {
    applicationId: varchar("application_id", { length: 21 })
      .$defaultFn(() => nanoid())
      .primaryKey(),

    workerId: varchar("worker_id", { length: 21 })
      .notNull()
      .references(() => workers.workerId, { onDelete: "cascade" }),

    gigId: varchar("gig_id", { length: 21 })
      .notNull()
      .references(() => gigs.gigId, { onDelete: "cascade" }),

    // 申請狀態：pending(待審核), approved(已核准), rejected(已拒絕), cancelled(已取消)
    status: varchar("status", {
      enum: ["pending", "approved", "rejected", "cancelled"],
    }).default("pending").notNull(),

    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
);

// ========== 5. 商家對打工者的評價（WorkerRatings） ==========
export const workerRatings = pgTable("worker_ratings", {
  ratingId: varchar("rating_id", { length: 21 })
    .$defaultFn(() => nanoid())
    .primaryKey(),

  // 關聯到具體的工作
  gigId: varchar("gig_id", { length: 21 })
    .notNull()
    .references(() => gigs.gigId, { onDelete: "cascade" }),

  workerId: varchar("worker_id", { length: 21 })
    .notNull()
    .references(() => workers.workerId, { onDelete: "cascade" }),

  employerId: varchar("employer_id", { length: 21 })
    .notNull()
    .references(() => employers.employerId, { onDelete: "cascade" }),

  ratingValue: integer("rating_value").default(5).notNull(),
  comment: text("comment"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ========== 6. 打工者對商家的評價（EmployerRatings） ==========
export const employerRatings = pgTable("employer_ratings", {
  ratingId: varchar("rating_id", { length: 21 })
    .$defaultFn(() => nanoid())
    .primaryKey(),

  // 關聯到具體的工作
  gigId: varchar("gig_id", { length: 21 })
    .notNull()
    .references(() => gigs.gigId, { onDelete: "cascade" }),

  employerId: varchar("employer_id", { length: 21 })
    .notNull()
    .references(() => employers.employerId, { onDelete: "cascade" }),

  workerId: varchar("worker_id", { length: 21 })
    .notNull()
    .references(() => workers.workerId, { onDelete: "cascade" }),

  ratingValue: integer("rating_value").default(5).notNull(),
  comment: text("comment"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ========== 7. 打卡碼表（Attendance Codes） ==========
export const attendanceCodes = pgTable("attendance_codes", {
  codeId: varchar("code_id", { length: 21 })
    .$defaultFn(() => nanoid())
    .primaryKey(),
  
  // 關聯到工作
  gigId: varchar("gig_id", { length: 21 })
    .notNull()
    .references(() => gigs.gigId, { onDelete: "cascade" }),
  
  // 4位打卡碼
  attendanceCode: varchar("attendance_code", { length: 4 }).notNull(),
  
  // 有效日期
  validDate: date("valid_date").notNull(),
  
  // 過期時間
  expiresAt: timestamp("expires_at").notNull(),
  
  createdAt: timestamp("created_at").defaultNow(),
});

// ========== 8. 打卡記錄表（Attendance Records） ==========
export const attendanceRecords = pgTable("attendance_records", {
  recordId: varchar("record_id", { length: 21 })
    .$defaultFn(() => nanoid())
    .primaryKey(),
  
  // 關聯到工作
  gigId: varchar("gig_id", { length: 21 })
    .notNull()
    .references(() => gigs.gigId, { onDelete: "cascade" }),
  
  // 關聯到打工者
  workerId: varchar("worker_id", { length: 21 })
    .notNull()
    .references(() => workers.workerId, { onDelete: "cascade" }),
  
  // 使用的打卡碼
  attendanceCodeId: varchar("attendance_code_id", { length: 21 })
    .notNull()
    .references(() => attendanceCodes.codeId, { onDelete: "cascade" }),
  
  // 打卡類型：check_in(上班打卡), check_out(下班打卡)
  checkType: varchar("check_type", {
    enum: ["check_in", "check_out"],
  }).notNull(),
  
  // 工作日期
  workDate: date("work_date").notNull(),
  
  // 打卡狀態：on_time(準時), late(遲到), early(早退)
  status: varchar("status", {
    enum: ["on_time", "late", "early"],
  }).default("on_time"),
  
  // 備註
  notes: text("notes"),
  
  // 打卡時間
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ========== 9. 系統通知（Notifications） ==========
export const notifications = pgTable("notifications", {
  notificationId: varchar("notification_id", { length: 21 })
    .$defaultFn(() => nanoid())
    .primaryKey(),

  // 接收者資訊
  receiverId: varchar("receiver_id", { length: 21 }).notNull(),

  // 通知內容
  title: varchar("title", { length: 256 }).notNull(),
  message: text("message").notNull(),

  // 通知類型
  type: varchar("type", { length: 128 }).notNull(),

  // 關聯資源 ID
  resourceId: varchar("resource_id", { length: 21 }),

  // 通知狀態
  isRead: boolean("is_read").default(false).notNull(),
  readAt: timestamp("read_at"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ==============================================
//               關聯定義 (Relations)
// ==============================================

// Workers
export const workersRelations = relations(workers, ({ many }) => ({
  gigApplications: many(gigApplications),
  workerRatings: many(workerRatings),
  employerRatings: many(employerRatings),
  attendanceRecords: many(attendanceRecords),
}));

// Employers
export const employersRelations = relations(employers, ({ many }) => ({
  gigs: many(gigs),
  workerRatings: many(workerRatings),
  employerRatings: many(employerRatings),
}));

// Gigs
export const gigsRelations = relations(gigs, ({ one, many }) => ({
  employer: one(employers, {
    fields: [gigs.employerId],
    references: [employers.employerId],
  }),
  gigApplications: many(gigApplications),
  workerRatings: many(workerRatings),
  employerRatings: many(employerRatings),
  attendanceCodes: many(attendanceCodes),
  attendanceRecords: many(attendanceRecords),
}));

// GigApplications
export const gigApplicationsRelations = relations(
  gigApplications,
  ({ one, many }) => ({
    worker: one(workers, {
      fields: [gigApplications.workerId],
      references: [workers.workerId],
    }),
    gig: one(gigs, {
      fields: [gigApplications.gigId],
      references: [gigs.gigId],
    }),
    attendanceRecords: many(attendanceRecords),
  }),
);

// WorkerRatings
export const workerRatingsRelations = relations(workerRatings, ({ one }) => ({
  worker: one(workers, {
    fields: [workerRatings.workerId],
    references: [workers.workerId],
  }),
  employer: one(employers, {
    fields: [workerRatings.employerId],
    references: [employers.employerId],
  }),
  gig: one(gigs, {
    fields: [workerRatings.gigId],
    references: [gigs.gigId],
  }),
}));

// EmployerRatings
export const employerRatingsRelations = relations(
  employerRatings,
  ({ one }) => ({
    employer: one(employers, {
      fields: [employerRatings.employerId],
      references: [employers.employerId],
    }),
    worker: one(workers, {
      fields: [employerRatings.workerId],
      references: [workers.workerId],
    }),
    gig: one(gigs, {
      fields: [employerRatings.gigId],
      references: [gigs.gigId],
    }),
  }),
);

// AttendanceCodes
export const attendanceCodesRelations = relations(attendanceCodes, ({ one, many }) => ({
  gig: one(gigs, {
    fields: [attendanceCodes.gigId],
    references: [gigs.gigId],
  }),
  attendanceRecords: many(attendanceRecords),
}));

// AttendanceRecords
export const attendanceRecordsRelations = relations(attendanceRecords, ({ one }) => ({
  gig: one(gigs, {
    fields: [attendanceRecords.gigId],
    references: [gigs.gigId],
  }),
  worker: one(workers, {
    fields: [attendanceRecords.workerId],
    references: [workers.workerId],
  }),
  attendanceCode: one(attendanceCodes, {
    fields: [attendanceRecords.attendanceCodeId],
    references: [attendanceCodes.codeId],
  }),
}));