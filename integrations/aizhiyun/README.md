# AIZHIYUN 官网线索接入

现网官网 `https://150.158.13.110/aizhiyun/` 当前是静态页面，联系表单的旧行为是“只在浏览器本地生成文件”。本目录提供接入 AEOS Public BFF 的浏览器适配器，不包含任何服务令牌。

## 接入步骤

1. 将 `contact-form.mjs` 放入官网静态资源目录，或从官网构建入口直接导入。
2. 在现有 `#contact-form` 中增加必选的隐私同意复选框：

   ```html
   <label>
     <input name="privacy_consent" type="checkbox" required>
     我同意按隐私政策处理本次咨询信息
   </label>
   ```

3. 用模块绑定当前表单；`#form-status` 可以继续作为状态区域：

   ```js
   import { bindPublicLeadForm } from './contact-form.mjs';

   bindPublicLeadForm(document.querySelector('#contact-form'), {
     endpoint: '/api/v1/public/leads',
     statusElement: document.querySelector('#form-status'),
     submitButton: document.querySelector('#contact-form button[type="submit"]')
   });
   ```

4. 删除或停用旧的“生成并下载项目简报”提交监听器，避免同一表单同时本地下载和远程提交。
5. 由 HTTPS 反向代理将 `/api/v1/public/leads` 转发到 M10 BFF；不要在浏览器代码中放置 `PUBLIC_BFF_TARGET_TOKEN`、EDP API Key 或 CRM 令牌。

适配器只发送姓名、邮箱/手机号、咨询方向、留言和同意版本；浏览器不展示 CRM 数据，只显示提交结果。适配器会拒绝 `file://` 页面，并为每次提交发送幂等键。

## 字段约定

现有官网表单字段可直接复用：`name`、`email`、`phone`（可选）、`interest`、`message`。同意复选框必须使用 `privacy_consent` 或 `consent`，且必须为选中状态。

## 环境要求

M10 生产环境必须配置精确允许的官网 Origin、正式 CAPTCHA、HTTPS 的 EDP 目标地址、服务令牌、租户 ID，并将 Outbox/DLQ 文件放在持久卷。浏览器只访问 M10 的公开入口，不直连 EDP、CRM 或数据库。
