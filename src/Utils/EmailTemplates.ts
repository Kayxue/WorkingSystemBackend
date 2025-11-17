export class EmailTemplates {
  private static escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * 生成密碼重設郵件 HTML 內容
   */
  static generatePasswordResetEmail(verificationCode: string, expiryMinutes: number = 30): string {
    return `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>密碼重設驗證</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .container {
            background: #f9f9f9;
            padding: 30px;
            border-radius: 10px;
            border: 1px solid #ddd;
        }
        .header {
            text-align: center;
            color: #2c3e50;
            margin-bottom: 30px;
        }
        .verification-code {
            background: #3498db;
            color: white;
            font-size: 32px;
            font-weight: bold;
            text-align: center;
            padding: 20px;
            border-radius: 8px;
            margin: 30px 0;
            letter-spacing: 8px;
        }
        .warning {
            background: #fff3cd;
            border: 1px solid #ffeaa7;
            border-radius: 5px;
            padding: 15px;
            margin: 20px 0;
            color: #856404;
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            font-size: 14px;
            color: #777;
        }
        .btn {
            display: inline-block;
            background: #27ae60;
            color: white;
            padding: 12px 30px;
            text-decoration: none;
            border-radius: 5px;
            margin: 20px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔐 密碼重設驗證</h1>
            <p>您好！我們收到了您的密碼重設請求</p>
        </div>

        <p>請使用以下 6 位數字驗證碼來重設您的密碼：</p>

        <div class="verification-code">
            ${verificationCode}
        </div>

        <div class="warning">
            <strong>⚠️ 重要提醒：</strong>
            <ul>
                <li>此驗證碼將在 <strong>${expiryMinutes} 分鐘</strong> 後失效</li>
                <li>請勿將此驗證碼分享給任何人</li>
                <li>如果您沒有請求密碼重設，請忽略此郵件</li>
            </ul>
        </div>

        <p>如果您無法使用驗證碼，請聯繫我們的客服團隊。</p>

        <div class="footer">
            <p>此郵件由系統自動發送，請勿回覆</p>
            <p>© 2025 SlotGo 打工平台. 保留所有權利.</p>
        </div>
    </div>
</body>
</html>`;
  }

  /**
   * 生成密碼重設成功通知郵件
   */
  static generatePasswordResetSuccessEmail(): string {
    return `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SlotGo 密碼重設成功</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .container {
            background: #f9f9f9;
            padding: 30px;
            border-radius: 10px;
            border: 1px solid #ddd;
        }
        .header {
            text-align: center;
            color: #27ae60;
            margin-bottom: 30px;
        }
        .success-icon {
            font-size: 48px;
            text-align: center;
            margin: 20px 0;
        }
        .info-box {
            background: #d4edda;
            border: 1px solid #c3e6cb;
            border-radius: 5px;
            padding: 15px;
            margin: 20px 0;
            color: #155724;
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            font-size: 14px;
            color: #777;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>✅ 密碼重設成功</h1>
        </div>

        <div class="success-icon">🎉</div>

        <p>您好！您的密碼已成功重設。</p>

        <div class="info-box">
            <strong>✅ 重設完成：</strong>
            <ul>
                <li>您的新密碼已生效</li>
                <li>可以使用新密碼登錄您的帳戶</li>
                <li>建議定期更新密碼以確保帳戶安全</li>
            </ul>
        </div>

        <p>如果這不是您本人的操作，請立即聯繫我們的客服團隊。</p>

        <div class="footer">
            <p>此郵件由系統自動發送，請勿回覆</p>
            <p>© 2025 SlotGo 打工平台. 保留所有權利.</p>
        </div>
    </div>
</body>
</html>`;
  }

  /**
   * 生成 Worker 註冊成功歡迎郵件
   */
  static generateWorkerWelcomeEmail(firstName: string): string {
    return `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>歡迎加入 SlotGo</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .container {
            background: #f9f9f9;
            padding: 30px;
            border-radius: 10px;
            border: 1px solid #ddd;
        }
        .header {
            text-align: center;
            color: #27ae60;
            margin-bottom: 30px;
        }
        .welcome-icon {
            font-size: 48px;
            text-align: center;
            margin: 20px 0;
        }
        .welcome-message {
            background: #d4edda;
            border: 1px solid #c3e6cb;
            border-radius: 5px;
            padding: 20px;
            margin: 20px 0;
            color: #155724;
        }
        .features {
            background: #e7f3ff;
            border: 1px solid #b3d7ff;
            border-radius: 5px;
            padding: 20px;
            margin: 20px 0;
        }
        .features h3 {
            color: #0066cc;
            margin-top: 0;
        }
        .features ul {
            margin: 10px 0 0 20px;
        }
        .cta-button {
            display: inline-block;
            background: #27ae60;
            color: white;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 5px;
            margin: 20px 0;
            font-weight: bold;
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            font-size: 14px;
            color: #777;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎉 歡迎加入 SlotGo！</h1>
        </div>

        <div class="welcome-icon">👋</div>

        <p>親愛的 ${firstName}，</p>

        <div class="welcome-message">
            <strong>🎊 恭喜您成功註冊 SlotGo 打工平台！</strong><br>
            您現在已經是我們大家庭的一員了。讓我們一起開始精彩的打工之旅吧！
        </div>

        <div class="features">
            <h3>🚀 平台特色功能</h3>
            <ul>
                <li>📱 輕鬆找到最適合的工作機會</li>
                <li>💼 多元化的工作類型選擇</li>
                <li>⭐ 真實的評價和評論系統</li>
                <li>💰 透明的薪資和福利資訊</li>
            </ul>
        </div>

        <p>現在就開始瀏覽工作機會，找到最適合您的工作吧！</p>

        <div style="text-align: center;">
            <a href="#" class="cta-button">開始瀏覽工作</a>
        </div>

        <div class="footer">
            <p>如果您有任何問題，歡迎隨時聯繫我們的客服團隊</p>
            <p>此郵件由系統自動發送，請勿回覆</p>
            <p>© 2025 SlotGo 打工平台. 保留所有權利.</p>
        </div>
    </div>
</body>
</html>`;
  }

  /**
   * 生成 Employer 註冊成功歡迎郵件
   */
  static generateEmployerWelcomeEmail(employerName: string): string {
    return `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>歡迎加入 SlotGo</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .container {
            background: #f9f9f9;
            padding: 30px;
            border-radius: 10px;
            border: 1px solid #ddd;
        }
        .header {
            text-align: center;
            color: #27ae60;
            margin-bottom: 30px;
        }
        .welcome-icon {
            font-size: 48px;
            text-align: center;
            margin: 20px 0;
        }
        .welcome-message {
            background: #d4edda;
            border: 1px solid #c3e6cb;
            border-radius: 5px;
            padding: 20px;
            margin: 20px 0;
            color: #155724;
        }
        .features {
            background: #e7f3ff;
            border: 1px solid #b3d7ff;
            border-radius: 5px;
            padding: 20px;
            margin: 20px 0;
        }
        .features h3 {
            color: #0066cc;
            margin-top: 0;
        }
        .features ul {
            margin: 10px 0 0 20px;
        }
        .cta-button {
            display: inline-block;
            background: #27ae60;
            color: white;
            padding: 15px 30px;
            text-decoration: none;
            border-radius: 5px;
            margin: 20px 0;
            font-weight: bold;
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            font-size: 14px;
            color: #777;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎉 歡迎加入 SlotGo！</h1>
        </div>

        <div class="welcome-icon">👋</div>

        <p>尊敬的 ${employerName} 團隊，</p>

        <div class="welcome-message">
            <strong>🎊 恭喜您成功註冊 SlotGo 打工平台！</strong><br>
            您現在已經加入我們的打工大家庭，讓我們一起開啟成功的招聘之旅！
        </div>

        <div class="features">
            <h3>🚀 平台特色功能</h3>
            <ul>
                <li>💼 快速發佈和管理工作機會</li>
                <li>⭐ 完整的評價系統</li>
                <li>🛡️ 安全的招聘保障</li>
            </ul>
        </div>

        <p>現在就開始發佈您的第一個工作機會，找到優秀的打工夥伴吧！</p>

        <div style="text-align: center;">
            <a href="#" class="cta-button">立即發佈工作</a>
        </div>

        <div class="footer">
            <p>如果您有任何問題，歡迎隨時聯繫我們的客服團隊</p>
            <p>此郵件由系統自動發送，請勿回覆</p>
            <p>© 2025 SlotGo 打工平台. 保留所有權利.</p>
        </div>
    </div>
</body>
</html>`;
  }

  static generateEmployerApprovalEmail(employerName: string): string {
    return `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SlotGo 帳戶審核通過通知</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .container {
            background: #f9f9f9;
            padding: 30px;
            border-radius: 10px;
            border: 1px solid #ddd;
        }
        .header {
            text-align: center;
            color: #27ae60;
            margin-bottom: 30px;
        }
        .success-icon {
            font-size: 48px;
            text-align: center;
            margin: 20px 0;
        }
        .info-box {
            background: #d4edda;
            border: 1px solid #c3e6cb;
            border-radius: 5px;
            padding: 20px;
            margin: 20px 0;
            color: #155724;
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            font-size: 14px;
            color: #777;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>✅ 帳戶審核通過</h1>
        </div>

        <div class="success-icon">🎉</div>

        <p>尊敬的 ${employerName} 團隊，</p>

        <div class="info-box">
            <strong>恭喜！您的 SlotGo 商家帳戶已通過審核。</strong><br>
            您現在可以正式登入平台，發佈職缺並管理您的招聘流程。
        </div>

        <p>建議您：</p>
        <ul>
            <li>立即登入後台，完善商家資料與公司介紹</li>
            <li>發佈第一個工作機會，吸引優秀的打工夥伴</li>
        </ul>

        <p>感謝您選擇 SlotGo，我們期待協助您找到最合適的人才。</p>

        <div class="footer">
            <p>此郵件由系統自動發送，請勿回覆</p>
            <p>© 2025 SlotGo 打工平台. 保留所有權利.</p>
        </div>
    </div>
</body>
</html>`;
  }

  static generateEmployerRejectionEmail(employerName: string, reason: string): string {
    const safeReason = this.escapeHtml(reason).replace(/\r?\n/g, "<br>");

    return `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SlotGo 帳戶審核結果通知</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .container {
            background: #fef6f6;
            padding: 30px;
            border-radius: 10px;
            border: 1px solid #f2d7d5;
        }
        .header {
            text-align: center;
            color: #c0392b;
            margin-bottom: 30px;
        }
        .alert-icon {
            font-size: 48px;
            text-align: center;
            margin: 20px 0;
        }
        .reason-box {
            background: #f9ebea;
            border: 1px solid #f5b7b1;
            border-radius: 5px;
            padding: 20px;
            margin: 20px 0;
            color: #7b241c;
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            font-size: 14px;
            color: #777;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>⚠️ 帳戶審核未通過</h1>
        </div>

        <div class="alert-icon">📩</div>

        <p>尊敬的 ${employerName} 團隊，</p>

        <p>感謝您申請加入 SlotGo 平台。經過審核，目前未能通過，原因如下：</p>

        <div class="reason-box">
            ${safeReason}
        </div>

        <p>若您有補充資料或需要協助，歡迎聯繫客服人員。</p>
        <p>期待未來能再度為您提供服務。</p>

        <div class="footer">
            <p>此郵件由系統自動發送，請勿回覆</p>
            <p>© 2025 SlotGo 打工平台. 保留所有權利.</p>
        </div>
    </div>
</body>
</html>`;
  }
}
