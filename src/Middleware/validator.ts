import { z } from "@nhttp/zod";
import { isValidCity, isValidDistrict } from "../Utils/AreaData";
import moment from "moment";

/* user route */
export const workerSignupSchema = z.object({
  email: z.string().email("Invalid email format"),
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
  certificates: z.array(z.string()).optional(),
});

export const employerSignupSchema = z.object({
  email: z.string().email("Invalid email format"),
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
  identificationNumber: z.string().min(5, "ID number too short"),
  contactInfo: z
    .object({
      contactPerson: z.string().min(2),
      contactEmail: z.string().email(),
      contactPhone: z.string().min(10),
    })
    .optional(),
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
  certificates: z.array(z.string()).optional(),
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
  contactInfo: z
    .object({
      contactPerson: z.string().optional(),
      contactEmail: z.string().email().optional(),
      contactPhone: z.string().optional(),
    })
    .optional(),
});

/* end user route */

// 工作發佈的驗證 Schema
export const createGigSchema = z.object({
  title: z.string().min(1, "工作標題不能為空").max(256, "工作標題過長"),
  description: z.any().optional(),
  dateStart: z.coerce.date().refine((date) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date >= today;
  }, {
    message: "工作開始日期不能是過去的日期"
  }),
  dateEnd: z.coerce.date().refine((date) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
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
  requirements: z.any().optional(),
  hourlyRate: z.coerce.number().min(1, "時薪必須大於 0").max(10000, "時薪過高"),
  city: z.string().min(1, "城市不能為空").max(32, "城市名稱過長"),
  district: z.string().min(1, "地區不能為空").max(32, "地區名稱過長"),
  address: z.string().min(1, "地址不能為空").max(256, "地址過長"),
  contactPerson: z.string().min(1, "聯絡人不能為空").max(32, "聯絡人姓名過長"),
  contactPhone: z.string().regex(/^(09\d{8}|\+8869\d{8}|0\d{1,2}-?\d{6,8})$/, "聯絡電話格式不正確").optional(),
  contactEmail: z.string().email("聯絡人 Email 格式不正確").max(128, "Email 過長").optional(),
  publishedAt: z.coerce.date().refine((date) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date >= today;
  }, {
    message: "刊登日期不能是過去的日期"
  }),
  unlistedAt: z.coerce.date().optional().refine((date) => {
    if (!date) return true; // 可選字段，沒值就通過
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date >= today;
  }, {
    message: "下架日期不能是過去的日期"
  }),
}).refine((data) => {
  if (data.timeStart && data.timeEnd) {
    const startTime = moment(data.timeStart, "HH:mm");
    const endTime = moment(data.timeEnd, "HH:mm");
    return endTime.isAfter(startTime);
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
  if (data.publishedAt && data.unlistedAt) {
    return data.unlistedAt >= data.publishedAt;
  }
  return true;
}, {
  message: "下架日期必須晚於刊登日期",
  path: ["unlistedAt"]
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
  description: z.any().optional(),
  dateStart: z.coerce.date().optional().refine((date) => {
    if (!date) return true; // 可選字段，沒值就通過
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date >= today;
  }, {
    message: "工作開始日期不能是過去的日期"
  }),
  dateEnd: z.coerce.date().optional().refine((date) => {
    if (!date) return true; // 可選字段，沒值就通過
    const today = new Date();
    today.setHours(0, 0, 0, 0);
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
  requirements: z.any().optional(),
  hourlyRate: z.coerce.number().min(1, "時薪必須大於 0").max(10000, "時薪過高").optional(),
  city: z.string().min(1, "城市不能為空").max(32, "城市名稱過長").optional(),
  district: z.string().min(1, "地區不能為空").max(32, "地區名稱過長").optional(),
  address: z.string().min(1, "地址不能為空").max(256, "地址過長").optional(),
  contactPerson: z.string().min(1, "聯絡人不能為空").max(32, "聯絡人姓名過長").optional(),
  contactPhone: z.string().regex(/^(09\d{8}|\+8869\d{8}|0\d{1,2}-?\d{6,8})$/, "聯絡電話格式不正確").optional(),
  contactEmail: z.string().email("聯絡人 Email 格式不正確").max(128, "Email 過長").optional(),
  publishedAt: z.coerce.date().optional().refine((date) => {
    if (!date) return true; // 可選字段，沒值就通過
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date >= today;
  }, {
    message: "刊登日期不能是過去的日期"
  }),
  unlistedAt: z.coerce.date().optional().refine((date) => {
    if (!date) return true; // 可選字段，沒值就通過
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date >= today;
  }, {
    message: "下架日期不能是過去的日期"
  }),
  isActive: z.coerce.boolean().optional(),
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
      const startTime = moment(data.timeStart, "HH:mm");
      const endTime = moment(data.timeEnd, "HH:mm");
      return endTime.isAfter(startTime);
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
  }).refine((data) => {
    // 刊登下架日期關係
    const publishedAt = data.publishedAt;
    const unlistedAt = data.unlistedAt;

    if (publishedAt && unlistedAt) {
      return unlistedAt >= publishedAt;
    }
    return true;
  }, {
    message: "下架日期必須晚於刊登日期",
    path: ["unlistedAt"]
  });

// 申請審核驗證 Schema
export const reviewApplicationSchema = z.object({
  status: z.enum(["approved", "rejected"], {
    required_error: "必須選擇核准或拒絕",
  }),
});

export const adminRegister = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Must contain at least one uppercase letter")
    .regex(/[a-z]/, "Must contain at least one lowercase letter")
    .regex(/[0-9]/, "Must contain at least one number")
})