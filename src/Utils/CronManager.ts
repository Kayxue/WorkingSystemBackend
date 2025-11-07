import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";

export class CronManager {
  private static dbClient: ReturnType<typeof drizzle> = (() => {
    if (!process.env.DBURL) {
      throw new Error("DBURL environment variable is not set.");
    }
    return drizzle(process.env.DBURL);
  })();

  /**
   * 檢查 pg_cron 擴展是否已安裝
   */
  static async checkPgCronExtension(): Promise<boolean> {
    try {
      const result = await CronManager.dbClient.execute(sql`
        SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
      `);
      return result.length > 0;
    } catch (error) {
      console.error("檢查 pg_cron 擴展時出錯:", error);
      return false;
    }
  }

  /**
   * 安裝 pg_cron 擴展
   */
  static async createPgCronExtension(): Promise<boolean> {
    try {
      await CronManager.dbClient.execute(
        sql`CREATE EXTENSION IF NOT EXISTS pg_cron`,
      );
      console.log("pg_cron 擴展已安裝");
      return true;
    } catch (error) {
      console.error("安裝 pg_cron 擴展失敗:", error);
      return false;
    }
  }
  
  /**
   * 檢查特定的 cron 任務是否存在
   */
  static async checkCronJobExists(jobName: string): Promise<boolean> {
    try {
      const result = await CronManager.dbClient.execute(sql`
        SELECT 1 FROM cron.job WHERE jobname = ${jobName}
      `);
      return result.length > 0;
    } catch (error) {
      console.error(`檢查 cron 任務 ${jobName} 時出錯:`, error);
      return false;
    }
  }

  /**
   * 創建自動取消超時未回應申請的 cron 任務
   * 超過3天未回應 pending_worker_confirmation 狀態的申請將自動改為 worker_cancelled
   */
  static async createAutoCancelTimeoutApplicationsJob(): Promise<boolean> {
    const jobName = "auto_cancel_timeout_applications";

    try {
      const exists = await CronManager.checkCronJobExists(jobName);
      if (exists) {
        return true;
      }

      // Cron 表達式: 每天 02:00 UTC (等於台北時間 10:00)
      const schedule = "0 2 * * *";

      // SQL 命令：將超過3天未回應的申請自動取消
      const command = `
        UPDATE gig_applications
        SET 
          status = 'worker_cancelled',
          updated_at = NOW()
        WHERE 
          status = 'pending_worker_confirmation'
          AND updated_at < NOW() - INTERVAL '3 days'
      `;

      await CronManager.dbClient.execute(sql`
        SELECT cron.schedule(
          ${jobName},
          ${schedule},
          ${command}
        );
      `);

      console.log(`已創建自動取消超時申請的 cron 任務: ${jobName}`);
      return true;
    } catch (error) {
      console.error(`創建 cron 任務 ${jobName} 失敗:`, error);
      return false;
    }
  }

  /**
   * 創建每天檢查 Worker 缺席的 cron 任務
   * 檢查昨天已確認的工作但未打卡的 worker
   * 缺席 3 次封鎖 30 天，之後每次加 30 天，最多 90 天
   */
  static async createCheckWorkerAbsenceJob(): Promise<boolean> {
    const jobName = "check_worker_absence";

    try {
      const exists = await CronManager.checkCronJobExists(jobName);
      if (exists) {
        return true;
      }

      // Cron 表達式: 每天 17:00 UTC (等於台北時間深夜 01:00)
      const schedule = "0 17 * * *";

      // SQL 命令：檢查昨天缺席的 worker 並自動封鎖
      const command = `
        DO $$
        DECLARE
          yesterday DATE := (CURRENT_DATE AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Taipei' - INTERVAL '1 day')::date;
          absence_record RECORD;
          total_absence_count INTEGER := 0;
          locked_count INTEGER := 0;
          new_absence_count INTEGER;
          lock_duration INTERVAL;
          new_locked_until TIMESTAMP;
          max_lock_duration INTERVAL := INTERVAL '90 days';
        BEGIN
          -- 查找昨天缺席的 worker（已確認工作但未打卡）
          FOR absence_record IN
            SELECT DISTINCT 
              ga.worker_id,
              ga.gig_id,
              g.title as gig_title,
              w.first_name,
              w.last_name,
              w.email,
              w.absence_count as current_absence_count
            FROM gig_applications ga
            INNER JOIN gigs g ON ga.gig_id = g.gig_id
            INNER JOIN workers w ON ga.worker_id = w.worker_id
            WHERE 
              ga.status = 'worker_confirmed'
              AND g.date_start <= yesterday
              AND g.date_end >= yesterday
              -- 沒有上班打卡記錄
              AND NOT EXISTS (
                SELECT 1 
                FROM attendance_records ar
                WHERE ar.worker_id = ga.worker_id
                  AND ar.gig_id = ga.gig_id
                  AND ar.work_date = yesterday
                  AND ar.check_type = 'check_in'
              )
          LOOP
            total_absence_count := total_absence_count + 1;
            
            -- 累積缺席次數
            new_absence_count := absence_record.current_absence_count + 1;
            
            -- 更新缺席次數
            UPDATE workers 
            SET absence_count = new_absence_count,
                updated_at = NOW()
            WHERE worker_id = absence_record.worker_id;
            
            -- 封鎖規則：3 次 30 天，之後每次加 30 天，最多 90 天
            IF new_absence_count >= 3 THEN
              -- 計算封鎖時長
              IF new_absence_count = 3 THEN
                lock_duration := INTERVAL '30 days';
              ELSE
                -- 每多一次缺席加 30 天：(absence_count - 2) * 30
                lock_duration := INTERVAL '30 days' * (new_absence_count - 2);
                
                -- 限制最大封鎖時長為 90 天
                IF lock_duration > max_lock_duration THEN
                  lock_duration := max_lock_duration;
                END IF;
              END IF;
              
              new_locked_until := NOW() + lock_duration;
              
              -- 封鎖帳號
              UPDATE workers 
              SET locked_until = new_locked_until,
                  updated_at = NOW()
              WHERE worker_id = absence_record.worker_id;
              
              locked_count := locked_count + 1;
            END IF;
          END LOOP;
        END $$;
      `;

      await CronManager.dbClient.execute(sql`
        SELECT cron.schedule(
          ${jobName},
          ${schedule},
          ${command}
        );
      `);

      console.log(`已創建檢查 Worker 缺席的 cron 任務: ${jobName}`);
      return true;
    } catch (error) {
      console.error(`創建 cron 任務 ${jobName} 失敗:`, error);
      return false;
    }
  }

  /**
   * 獲取所有 cron 任務狀態
   */
  static async getCronJobsStatus(): Promise<any[]> {
    try {
      const result = await CronManager.dbClient.execute(sql`
        SELECT 
          jobid,
          schedule,
          command,
          nodename,
          nodeport,
          database,
          username,
          active,
          jobname
        FROM cron.job
      `);
      return result;
    } catch (error) {
      console.error("獲取 cron 任務狀態時出錯:", error);
      return [];
    }
  }

  /**
   * 初始化所有必要的 cron 任務
   */
  static async initializeCronJobs(): Promise<boolean> {
    // 1. 檢查 pg_cron 擴展
    const hasExtension = await CronManager.checkPgCronExtension();
    if (!hasExtension) {
      console.log("pg_cron 擴展未安裝，嘗試安裝...");
      const installed = await CronManager.createPgCronExtension();
      if (!installed) {
        console.error("pg_cron 初始化失敗：無法安裝擴展");
        return false;
      }
    }

    // 2. 創建自動取消超時申請任務
    const autoCancelCreated = await CronManager.createAutoCancelTimeoutApplicationsJob();
    if (!autoCancelCreated) {
      console.error("自動取消超時申請任務創建失敗");
      return false;
    }

    // 3. 創建檢查 Worker 缺席任務
    const checkAbsenceCreated = await CronManager.createCheckWorkerAbsenceJob();
    if (!checkAbsenceCreated) {
      console.error("檢查 Worker 缺席任務創建失敗");
      return false;
    }

    // 4. 顯示當前任務狀態
    const jobs = await CronManager.getCronJobsStatus();
    if (jobs.length > 0) {
      console.log("當前 cron 任務:");
      jobs.forEach((job) => {
        console.log(
          `  - ${job.jobname}: ${job.schedule} (${job.active ? "啟用" : "停用"})`,
        );
      });
    }

    return true;
  }
}

export default CronManager;