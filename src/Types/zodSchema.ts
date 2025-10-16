import * as z from "zod";
import { isValidCity, isValidDistrict } from "../Utils/AreaData";
import { DateUtils } from "../Utils/DateUtils";
import { Role } from "./types";

export const loginSchema = z.object({
  email: z.email("Invalid email format"),
  password: z.string(),
});

/* user route schemas */
export const workerSignupSchema = z.object({
  email: z.email("Invalid email format"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Must contain at least one uppercase letter")
    .regex(/[a-z]/, "Must contain at least one lowercase letter")
    .regex(/[0-9]/, "Must contain at least one number"),
  firstName: z.string(),
  lastName: z.string(),
  phoneNumber: z
    .string()
    .regex(/^(09\d{8}|\+8869\d{8}|0\d{1,2}-?\d{6,8})$/, "Invalid phone number"),
  highestEducation: z
    .enum(["高中", "大學", "碩士", "博士", "其他"])
    .default("大學"),
  schoolName: z.string().optional(),
  major: z.string().optional(),
  studyStatus: z.enum(["就讀中", "已畢業", "肄業"]),
  certificates: z.array(z
    .enum(["普通小型車", "職業小型車", "普通大貨車", "職業大貨車",
      "普通大客車", "職業大客車", "普通聯結車", "職業聯結車",
      "小型輕型機車", "普通輕型機車", "普通重型機車", "大型重型機車"
    ])
  ).optional(),
  jobExperience: z.array(z.string()).optional(),
});

export const employerSignupSchema = z.object({
  email: z.email("Invalid email format"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Must contain at least one uppercase letter")
    .regex(/[a-z]/, "Must contain at least one lowercase letter")
    .regex(/[0-9]/, "Must contain at least one number"),
  employerName: z.string(),
  branchName: z.string().optional(),
  industryType: z.string().min(2, "Industry type required"),
  address: z.string().min(5, "Address must be at least 5 characters"),
  phoneNumber: z
    .string()
    .regex(/^(09\d{8}|\+8869\d{8}|0\d{1,2}-?\d{6,8})$/, "Invalid phone number"),
  identificationType: z.enum(["businessNo", "personalId"]),
  identificationNumber: z.string().min(5, "ID number too short")
});

export const updateWorkerProfileSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phoneNumber: z
    .string()
    .regex(/^(09\d{8}|\+8869\d{8}|0\d{1,2}-?\d{6,8})$/, "Invalid phone number")
    .optional(),
  highestEducation: z
    .enum(["高中", "大學", "碩士", "博士", "其他"])
    .optional(),
  schoolName: z.string().optional(),
  major: z.string().optional(),
  studyStatus: z.enum(["就讀中", "已畢業", "肄業"]).optional(),
  certificates: z.array(z
    .enum(["普通小型車", "職業小型車", "普通大貨車", "職業大貨車",
      "普通大客車", "職業大客車", "普通聯結車", "職業聯結車",
      "小型輕型機車", "普通輕型機車", "普通重型機車", "大型重型機車"
    ])
  ).optional(),
  jobExperience: z.array(z.string()).optional(),
});

export const updateEmployerProfileSchema = z.object({
  employerName: z.string().optional(),
  branchName: z.string().optional(),
  industryType: z
    .enum(["餐飲", "批發/零售", "倉儲運輸", "展場活動", "其他"])
    .optional(),
  identificationType: z.enum(["businessNo", "personalId"]).optional(),
  address: z.string().optional(),
  phoneNumber: z
    .string()
    .regex(/^(09\d{8}|\+8869\d{8}|0\d{1,2}-?\d{6,8})$/, "Invalid phone number")
    .optional(),
});

export const updatePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Must contain at least one uppercase letter")
    .regex(/[a-z]/, "Must contain at least one lowercase letter")
    .regex(/[0-9]/, "Must contain at least one number"),
});

/* password reset schemas */
export const passwordResetRequestSchema = z.object({
  email: z.email("Invalid email format"),
});

export const passwordResetVerifySchema = z.object({
  email: z.email("Invalid email format"),
  verificationCode: z
    .string()
    .length(6, "驗證碼必須是6位數字")
    .regex(/^\d{6}$/, "驗證碼只能包含數字"),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Must contain at least one uppercase letter")
    .regex(/[a-z]/, "Must contain at least one lowercase letter")
    .regex(/[0-9]/, "Must contain at least one number"),
});

/* gig route schemas */
const requirementsObjectSchema = z.object({
  skills: z.array(z.string()).min(1, "技能至少需要 1 筆"),
  experience: z.string().min(1, "經驗不能為空"),
});

export const createGigSchema = z.object({
  title: z.string().min(1, "工作標題不能為空").max(256, "工作標題過長"),
  description: z.string().min(1, "工作描述不能為空").max(10000, "工作描述過長"),
  dateStart: z.coerce.date().refine((date) => {
    const today = DateUtils.getCurrentDateObject();
    return date >= today;
  }, {
    message: "工作開始日期不能是過去的日期"
  }),
  dateEnd: z.coerce.date().refine((date) => {
    const today = DateUtils.getCurrentDateObject();
    return date >= today;
  }, {
    message: "工作結束日期不能是過去的日期"
  }),
  timeStart: z.string().transform((val) => {
    if (/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(val)) {
      return val;
    }
    const timeMatch = val.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      const hour = timeMatch[1].padStart(2, '0');
      const minute = timeMatch[2];
      return `${hour}:${minute}`;
    }
    throw new Error("時間格式不正確 (應為 HH:MM)");
  }),
  timeEnd: z.string().transform((val) => {
    if (/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(val)) {
      return val;
    }
    const timeMatch = val.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      const hour = timeMatch[1].padStart(2, '0');
      const minute = timeMatch[2];
      return `${hour}:${minute}`;
    }
    throw new Error("時間格式不正確 (應為 HH:MM)");
  }),
  requirements: z.preprocess((val) => {
    if (typeof val === "string") {
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    }
    return val;
  }, requirementsObjectSchema),
  hourlyRate: z.coerce.number().min(1, "時薪必須大於 0").max(10000, "時薪過高"),
  city: z.string().min(1, "城市不能為空").max(32, "城市名稱過長"),
  district: z.string().min(1, "地區不能為空").max(32, "地區名稱過長"),
  address: z.string().min(1, "地址不能為空").max(256, "地址過長"),
  contactPerson: z.string().min(1, "聯絡人不能為空").max(32, "聯絡人姓名過長"),
  contactPhone: z.string().regex(/^(09\d{8}|\+8869\d{8}|0\d{1,2}-?\d{6,8})$/, "聯絡電話格式不正確").optional(),
  contactEmail: z.email("聯絡人 Email 格式不正確").max(128, "Email 過長").optional(),
}).refine((data) => {
  if (data.timeStart && data.timeEnd) {
    return DateUtils.isTimeAfter(data.timeEnd, data.timeStart);
  }
  return true;
}, {
  message: "結束時間必須晚於開始時間",
  path: ["timeEnd"]
}).refine((data) => {
  if (data.dateStart && data.dateEnd) {
    return data.dateEnd >= data.dateStart;
  }
  return true;
}, {
  message: "結束日期必須晚於或等於開始日期",
  path: ["dateEnd"]
}).refine((data) => {
  // 驗證城市是否有效
  return isValidCity(data.city);
}, {
  message: "請選擇有效的城市",
  path: ["city"]
}).refine((data) => {
  // 驗證城市和區域的組合是否有效
  return isValidDistrict(data.city, data.district);
}, {
  message: "所選區域不屬於指定城市",
  path: ["district"]
});

export const updateGigSchema = z.object({
  title: z.string().min(1, "工作標題不能為空").max(256, "工作標題過長").optional(),
  description: z.string().min(1, "工作描述不能為空").max(10000, "工作描述過長").optional(),
  dateStart: z.coerce.date().optional(),
  dateEnd: z.coerce.date().optional(),
  timeStart: z.string().transform((val) => {
    if (/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(val)) {
      return val;
    }
    const timeMatch = val.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      const hour = timeMatch[1].padStart(2, '0');
      const minute = timeMatch[2];
      return `${hour}:${minute}`;
    }
    throw new Error("時間格式不正確 (應為 HH:MM)");
  }).optional(),
  timeEnd: z.string().transform((val) => {
    if (/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(val)) {
      return val;
    }
    const timeMatch = val.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      const hour = timeMatch[1].padStart(2, '0');
      const minute = timeMatch[2];
      return `${hour}:${minute}`;
    }
    throw new Error("時間格式不正確 (應為 HH:MM)");
  }).optional(),
  requirements: z.preprocess((val) => {
    if (typeof val === "string") {
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    }
    return val;
  }, requirementsObjectSchema).optional(),
  hourlyRate: z.coerce.number().min(1, "時薪必須大於 0").max(10000, "時薪過高").optional(),
  city: z.string().min(1, "城市不能為空").max(32, "城市名稱過長").optional(),
  district: z.string().min(1, "地區不能為空").max(32, "地區名稱過長").optional(),
  address: z.string().min(1, "地址不能為空").max(256, "地址過長").optional(),
  contactPerson: z.string().min(1, "聯絡人不能為空").max(32, "聯絡人姓名過長").optional(),
  contactPhone: z.string().regex(/^(09\d{8}|\+8869\d{8}|0\d{1,2}-?\d{6,8})$/, "聯絡電話格式不正確").optional(),
  contactEmail: z.email("聯絡人 Email 格式不正確").max(128, "Email 過長").optional(),
  deletedPhotoFiles: z.string().optional(),
})
  // 1. 成對驗證
  .refine((data) => {
    // 日期必須成對出現
    const hasDateStart = data.dateStart !== undefined;
    const hasDateEnd = data.dateEnd !== undefined;
    return hasDateStart === hasDateEnd;
  }, {
    message: "工作開始日期和結束日期必須同時提供",
    path: ["dateStart", "dateEnd"]
  }).refine((data) => {
    // 時間必須成對出現
    const hasTimeStart = data.timeStart !== undefined;
    const hasTimeEnd = data.timeEnd !== undefined;
    return hasTimeStart === hasTimeEnd;
  }, {
    message: "工作開始時間和結束時間必須同時提供",
    path: ["timeStart", "timeEnd"]
  }).refine((data) => {
    // 城市和區域必須成對出現
    const hasCity = data.city !== undefined;
    const hasDistrict = data.district !== undefined;
    return hasCity === hasDistrict;
  }, {
    message: "城市和區域必須同時提供",
    path: ["city", "district"]
  })
  // 2. 有效性驗證
  .refine((data) => {
    // 如果提供了 city，則必須是有效的
    if (data.city) {
      return isValidCity(data.city);
    }
    return true;
  }, {
    message: "請選擇有效的城市",
    path: ["city"]
  }).refine((data) => {
    // 如果提供了 city 和 district，則組合必須是有效的
    if (data.city && data.district) {
      return isValidDistrict(data.city, data.district);
    }
    return true;
  }, {
    message: "所選區域不屬於指定城市",
    path: ["district"]
  })
  // 3. 邏輯驗證
  .refine((data) => {
    // 時間關係
    if (data.timeStart && data.timeEnd) {
      return DateUtils.isTimeAfter(data.timeEnd, data.timeStart);
    }
    return true;
  }, {
    message: "結束時間必須晚於開始時間",
    path: ["timeEnd"]
  }).refine((data) => {
    // 日期關係
    if (data.dateStart && data.dateEnd) {
      return data.dateEnd >= data.dateStart;
    }
    return true;
  }, {
    message: "結束日期必須晚於或等於開始日期",
    path: ["dateEnd"]
  });

/* application route schemas */
// 企業審核申請
export const reviewApplicationSchema = z.object({
  action: z.enum(["approve", "reject"], {
    message: "必須選擇核准（approve）或拒絕（reject）",
  }),
});

// 打工者確認是否接受工作
export const workerConfirmApplicationSchema = z.object({
  action: z.enum(["accept", "decline"], {
    message: "必須選擇接受（accept）或拒絕（decline）",
  }),
});

/* rating route schemas */
export const createRatingSchema = z.object({
  ratingValue: z.number().int().min(1).max(5, "評分必須在1到5之間"),
  comment: z.string().max(1000, "評論不能超過1000字").optional(),
});

/* admin route schemas */
export const adminRegisterSchema = z.object({
  email: z.email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Must contain at least one uppercase letter")
    .regex(/[a-z]/, "Must contain at least one lowercase letter")
    .regex(/[0-9]/, "Must contain at least one number")
});

/* notification route schemas */
const notificationTypeEnum = z.enum(["application", "rating", "account", "system"]);

export const createNotificationSchema = z.object({
  receiverId: z.string().min(1, "接收者ID不能為空"),
  userRole: z.enum(Role),
  title: z.string().min(1, "標題不能為空").max(256, "標題過長"),
  message: z.string().min(1, "訊息不能為空"),
  type: notificationTypeEnum,
  resourceId: z.string().min(1).optional(),
  sendPush: z.boolean().default(false),
});

export const markAsReadSchema = z.object({
  notificationIds: z.array(z.string()).min(1, "至少需要一個通知ID"),
});

export const createBatchNotificationSchema = z.object({
  receiverIds: z.array(z.string()).min(1, "至少需要一個接收者ID"),
  title: z.string().min(1, "標題不能為空").max(256, "標題過長"),
  message: z.string().min(1, "訊息不能為空"),
  type: notificationTypeEnum,
  resourceId: z.string().min(1).optional(),
});

export const createGroupNotificationSchema = z.object({
  groups: z.object({
    workers: z.boolean().optional(),
    employers: z.boolean().optional(),
    admins: z.boolean().optional(),
  }).refine(data => Object.values(data).some(Boolean), {
    message: "至少需要選擇一個群組",
  }),
  title: z.string().min(1, "標題不能為空").max(256, "標題過長"),
  message: z.string().min(1, "訊息不能為空"),
  type: notificationTypeEnum,
  resourceId: z.string().min(1).optional(),
  sendPush: z.boolean().default(false),
});

/* attendance system schemas */

// 打工者打卡
export const attendanceCheckSchema = z.object({
  gigId: z.string().min(1, "工作ID不能為空"),
  attendanceCode: z.string()
    .length(4, "打卡碼必須是4位數字")
    .regex(/^\d{4}$/, "打卡碼只能包含數字"),
  checkType: z.enum(["check_in", "check_out"], {
    message: "打卡類型必須是check_in或check_out",
  }),
});

// 查詢打卡記錄
export const getAttendanceRecordsSchema = z.object({
  gigId: z.string().min(1, "工作ID不能為空").optional(),
  workerId: z.string().min(1, "打工者ID不能為空").optional(),
  checkType: z.enum(["check_in", "check_out"]).optional()
}).refine((data) => {
  return data.gigId || data.workerId;
}, {
  message: "必須提供工作ID或打工者ID至少一個",
  path: ["gigId", "workerId"]
});

// 雇主修改打卡記錄
export const updateAttendanceRecordSchema = z.object({
  records: z.array(
    z.object({
      recordId: z.string().min(1, "記錄ID不能為空"),
      status: z.enum(["on_time", "late", "early"]).optional(),
      attendanceConfirmation: z.enum(["pending", "confirmed", "rejected"]).optional(),
      notes: z.string().max(500, "備註不能超過500字").optional(),
    }).refine((data) => {
      return data.status || data.attendanceConfirmation || data.notes;
    }, {
      message: "至少需要提供 status、attendanceConfirmation 或 notes 其中一個欄位",
    })
  )
  .min(1, "至少需要一筆記錄")
  .max(100, "一次最多更新100筆記錄")
});

/* FCM token schemas */
export const registerFCMTokenSchema = z.object({
  token: z.string().min(1, "FCM token 不能為空"),
  deviceType: z.enum(["android", "ios", "web"], {
    message: "設備類型必須是 android、ios 或 web",
  }),
});

export const deleteFCMTokensSchema = z.object({
  tokens: z.array(z.string().min(1, "FCM token 不能為空")).min(1, "至少需要一個 token"),
});

export const sendTestPushSchema = z.object({
  title: z.string().min(1, "標題不能為空").max(256, "標題過長"),
  message: z.string().min(1, "訊息不能為空"),
  data: z.record(z.string(), z.string()).optional(),
});