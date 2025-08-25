import { createMiddleware } from "hono/factory"
import { Role, type sessionUser, type HonoGenericContext } from "../Types/types"
import dbClient from "../Client/DrizzleClient"
import { admins, employers, workers } from "../Schema/DatabaseSchema"
import { eq } from "drizzle-orm"
import { loginSchema } from "../Types/zodSchema"
import { verify } from "@node-rs/argon2"
import { argon2Config } from "../config"
import type { Session } from "hono-sessions"
import { UserCache } from "../Client/Cache/Index"
import SessionManager from "../Utils/SessionManager"
import { LoginAttemptManager } from "../Utils/LoginAttemptManager";

export const authenticate = createMiddleware<HonoGenericContext>(async (c, next) => {
    const session = c.get("session");

    if (session.get("id")) {
        return c.text("已經登入", 401);
    }

    const { platform } = c.req.header();

    if (!platform?.length) {
        return c.text("Platform is required", 401);
    }

    const body = await c.req.json();
    let user: { email: string; password: string };
    try {
        user = loginSchema.parse(body);
    } catch (error) {
        return c.text("Invalid request body", 400);
    }

    const { email, password } = user;
    
    // 檢查用戶登錄狀態
    const loginStatus = await LoginAttemptManager.getLoginStatus(email);

    if (loginStatus.isLocked) {
        const minutes = Math.ceil(loginStatus.remainingLockTime / 60);
        return c.text(`帳號已被鎖定，請 ${minutes} 分鐘後再試`, 423);
    }
    
    if (platform === "web-employer") {
        const employer = await dbClient.query.employers.findFirst({
            where: eq(employers.email, email),
        });
        if (!employer) {
            return c.text("No employer found", 401);
        }
        const passwordCorrect = await verify(
            employer.password,
            password,
            argon2Config,
        );
        if (!passwordCorrect) {
            const { isLocked: newLock, attemptsLeft } = await LoginAttemptManager.recordFailedAttempt(email);
            if (newLock) {
                return c.text("密碼錯誤次數過多，帳號已被鎖定 5 分鐘", 423);
            }
            return c.text(`密碼錯誤，剩餘嘗試次數：${attemptsLeft}`, 401);
        }
        
        const payload: sessionUser = {
            id: employer.employerId,
            role: Role.EMPLOYER,
        };
        
        session.set("id", payload.id);
        session.set("role", payload.role);
        const realSessionId = session.getCache()._id;
        await SessionManager.track(payload.id, realSessionId);
        await LoginAttemptManager.clearFailedAttempts(email);
        return next();
    }

    if (platform === "web-admin") {
        const admin = await dbClient.query.admins.findFirst({
            where: eq(admins.email, email),
        });
        if (!admin) {
            return c.text("No admin found", 401);
        }
        const passwordCorrect = await verify(
            admin.password,
            password,
            argon2Config,
        );
        if (!passwordCorrect) {
            const { isLocked: newLock, attemptsLeft } = await LoginAttemptManager.recordFailedAttempt(email);
            if (newLock) {
                return c.text("密碼錯誤次數過多，帳號已被鎖定 5 分鐘", 423);
            }
            return c.text(`密碼錯誤，剩餘嘗試次數：${attemptsLeft}`, 401);
        }
        
        const payload: sessionUser = {
            id: admin.adminId,
            role: Role.ADMIN,
        };
        
        session.set("id", payload.id);
        session.set("role", payload.role);
        const realSessionId = session.getCache()._id;
        await SessionManager.track(payload.id, realSessionId);
        await LoginAttemptManager.clearFailedAttempts(email);
        return next();
    }

    if (platform === "mobile") {
        const worker = await dbClient.query.workers.findFirst({
            where: eq(workers.email, email),
        });
        if (!worker) {
            return c.text("No worker found", 401);
        }
        const passwordCorrect = await verify(
            worker.password,
            password,
            argon2Config,
        );
        if (!passwordCorrect) {
            const { isLocked: newLock, attemptsLeft } = await LoginAttemptManager.recordFailedAttempt(email);
            if (newLock) {
                return c.text("密碼錯誤次數過多，帳號已被鎖定5分鐘", 423);
            }
            return c.text(`密碼錯誤，剩餘嘗試次數：${attemptsLeft}`, 401);
        }
        
        const payload: sessionUser = {
            id: worker.workerId,
            role: Role.WORKER,
        };
        
        session.set("id", payload.id);
        session.set("role", payload.role);
        const realSessionId = session.getCache()._id;
        await SessionManager.track(payload.id, realSessionId);
        await LoginAttemptManager.clearFailedAttempts(email);
        return next();
    }
    return c.text("Platform not supported", 401);
})

export const authenticated = createMiddleware<HonoGenericContext>(async (c, next) => {
    const session = c.get("session");
    const userId = session.get("id");
    
    if (!userId) {
        return c.text("Unauthorized", 401);
    }
    
    // 檢查用戶是否被踢下線
    const sessionId = session.getCache()._id;
    const isActive = await SessionManager.isActive(userId, sessionId);

    if (!isActive) {
        session.deleteSession();
        return c.text("被踢下線", 401);
    }
    
    const user = await deserializeUser(session);

    if (!user) {
        return c.text("Unauthorized", 401);
    }
    
    c.set("user", user);
    return next();
})

export async function deserializeUser(session: Session<sessionUser>) {
    const id = session.get("id")
    const role = session.get("role");

    // 使用快取系統
    const cachedUser = await UserCache.getUserProfile(id, role);

    if (cachedUser) {
        return { ...cachedUser, role, userId: id };
    }

    if (role === Role.EMPLOYER) {
        const employer = await dbClient.query.employers.findFirst({
            where: eq(employers.employerId, id),
        });
        if (!employer) {
            return null
        }
        const { password, ...remains } = employer;
        const userData = { ...remains, role: Role.EMPLOYER, userId: id };
        await UserCache.setUserProfile(id, role, userData);
        return userData;
    }
    if (role === Role.WORKER) {
        const worker = await dbClient.query.workers.findFirst({
            where: eq(workers.workerId, id),
        });
        if (!worker) {
            return null
        }
        const { password, ...remains } = worker;
        const userData = { ...remains, role: Role.WORKER, userId: id };
        await UserCache.setUserProfile(id, role, userData);
        return userData;
    }
    if (role === Role.ADMIN) {
        const admin = await dbClient.query.admins.findFirst({
            where: eq(admins.adminId, id),
        });
        if (!admin) return null
        const { password, ...remains } = admin;
        const userData = { ...remains, role: Role.ADMIN, userId: id };
        await UserCache.setUserProfile(id, role, userData);
        return userData;
    }
    return null
}