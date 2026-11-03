'use strict';

// 官网公开线索 BFF：只接收最小必要字段，先落持久 Outbox，再投递
// LeadIntakeV1。该模块不依赖 CRM 数据库，也不向浏览器返回内部对象。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PUBLIC_LEAD_CONTRACT = 'LeadIntakeV1';
const PUBLIC_LEAD_PATH = '/api/v1/public/leads';
const DEFAULT_ALLOWED_ORIGIN = 'http://localhost:3000';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+()\-\s\d]{6,32}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{1,160}$/;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function isProduction(env) {
  return String(env.NODE_ENV || '').toLowerCase() === 'production';
}

function createPublicLeadConfig(env = process.env) {
  const production = isProduction(env);
  const allowedOrigins = splitList(env.PUBLIC_BFF_ALLOWED_ORIGINS || env.AEOS_PUBLIC_ORIGIN);
  const captchaMode = String(env.PUBLIC_BFF_CAPTCHA_MODE || (production ? 'provider' : 'disabled')).toLowerCase();
  const targetUrl = String(env.PUBLIC_BFF_TARGET_URL || '').trim();

  if (production) {
    if (!allowedOrigins.length || allowedOrigins.includes('*')) {
      throw fail('生产环境必须配置 PUBLIC_BFF_ALLOWED_ORIGINS，且不得使用通配符', 500);
    }
    if (captchaMode !== 'provider' || !String(env.PUBLIC_BFF_CAPTCHA_VERIFY_URL || '').trim()) {
      throw fail('生产环境必须配置 CAPTCHA provider', 500);
    }
    if (!targetUrl || !/^https:\/\//i.test(targetUrl)) {
      throw fail('生产环境必须配置 HTTPS 的 PUBLIC_BFF_TARGET_URL', 500);
    }
    if (!String(env.PUBLIC_BFF_TARGET_TOKEN || '').trim()) {
      throw fail('生产环境必须配置 Public BFF 到目标系统的服务令牌', 500);
    }
    if (!String(env.PUBLIC_BFF_TENANT_ID || '').trim()) {
      throw fail('生产环境必须配置 PUBLIC_BFF_TENANT_ID', 500);
    }
  }

  const retentionDays = Number(env.PUBLIC_BFF_RETENTION_DAYS || 730);
  const rateLimitWindowMs = Number(env.PUBLIC_BFF_RATE_WINDOW_MS || 60_000);
  const rateLimitMax = Number(env.PUBLIC_BFF_RATE_LIMIT_MAX || 10);
  const maxAttempts = Number(env.PUBLIC_BFF_MAX_ATTEMPTS || 5);
  if (![retentionDays, rateLimitWindowMs, rateLimitMax, maxAttempts].every(value => Number.isFinite(value) && value > 0)) {
    throw fail('Public BFF 限流、保留期和重试配置必须为正数', 500);
  }

  return {
    production,
    allowedOrigins: allowedOrigins.length ? allowedOrigins : [DEFAULT_ALLOWED_ORIGIN],
    captchaMode,
    captchaVerifyUrl: String(env.PUBLIC_BFF_CAPTCHA_VERIFY_URL || '').trim(),
    targetUrl,
    targetToken: String(env.PUBLIC_BFF_TARGET_TOKEN || ''),
    tenantId: String(env.PUBLIC_BFF_TENANT_ID || '').trim() || undefined,
    retentionDays,
    rateLimitWindowMs,
    rateLimitMax,
    maxAttempts,
    targetTimeoutMs: Number(env.PUBLIC_BFF_TARGET_TIMEOUT_MS || 5_000),
    outboxPath: String(env.PUBLIC_BFF_OUTBOX_FILE || path.join('var', 'public-lead-outbox.jsonl')),
    dlqPath: String(env.PUBLIC_BFF_DLQ_FILE || path.join('var', 'public-lead-dlq.jsonl'))
  };
}

function allowedOrigin(origin, origins) {
  return typeof origin === 'string' && origins.includes(origin);
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!key) return crypto.randomUUID();
  if (!IDEMPOTENCY_RE.test(key)) throw fail('Idempotency-Key 格式不正确');
  return key;
}

function normalizePublicLead(body, config, now = new Date()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('请求体格式不正确');
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  const interest = String(body.interest || '').trim();
  const message = String(body.message || '').trim();
  const consent = body.consent;

  if (!name || name.length > 120) throw fail('姓名不能为空且不得超过 120 个字符');
  if (!email && !phone) throw fail('邮箱和手机号至少填写一项');
  if (email && !EMAIL_RE.test(email)) throw fail('邮箱格式不正确');
  if (phone && !PHONE_RE.test(phone)) throw fail('手机号格式不正确');
  if (!interest || interest.length > 160) throw fail('需求主题不能为空且不得超过 160 个字符');
  if (message.length > 4000) throw fail('留言不得超过 4000 个字符');
  if (!consent || consent.granted !== true || !String(consent.version || '').trim() || !String(consent.purpose || '').trim()) {
    throw fail('必须明确同意隐私处理条款');
  }

  const submittedAt = now.toISOString();
  const retentionUntil = new Date(now.getTime() + config.retentionDays * 86400000).toISOString();
  const intakeId = `lead_${crypto.randomUUID()}`;
  const idempotencyKey = normalizeIdempotencyKey(body.idempotency_key);
  return {
    contract_version: PUBLIC_LEAD_CONTRACT,
    intake_id: intakeId,
    source_system: 'PUBLIC_BFF',
    submitted_at: submittedAt,
    contact: { name, email_or_phone: email || phone },
    interest,
    ...(message ? { message } : {}),
    consent: {
      granted: true,
      version: String(consent.version).trim().slice(0, 80),
      purpose: String(consent.purpose).trim().slice(0, 160),
      retention_until: retentionUntil,
      ...(consent.deletion_requested === true ? { deletion_requested: true } : {})
    },
    trace_id: crypto.randomUUID(),
    idempotency_key: idempotencyKey,
    ...(config.tenantId ? { tenant_id: config.tenantId } : {})
  };
}

function createRateLimiter({ windowMs = 60_000, max = 10, now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    allow(key) {
      const current = now();
      const previous = entries.get(key);
      if (!previous || current - previous.startedAt >= windowMs) {
        entries.set(key, { startedAt: current, count: 1 });
        return true;
      }
      if (previous.count >= max) return false;
      previous.count += 1;
      return true;
    },
    clear() {
      entries.clear();
    }
  };
}

async function verifyCaptcha({ token, clientKey, config, fetchImpl = globalThis.fetch }) {
  if (config.captchaMode === 'disabled' && !config.production) return;
  if (!token) throw fail('验证码校验失败', 403);
  if (config.captchaMode !== 'provider' || !config.captchaVerifyUrl || typeof fetchImpl !== 'function') {
    throw fail('验证码服务未正确配置', 503);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.targetTimeoutMs);
  try {
    const response = await fetchImpl(config.captchaVerifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, client_key: clientKey }),
      signal: controller.signal
    });
    if (!response.ok) throw fail('验证码校验失败', 403);
    const result = await response.json();
    if (!result || result.success !== true) throw fail('验证码校验失败', 403);
  } catch (error) {
    if (error.status) throw error;
    throw fail('验证码服务暂不可用', 503);
  } finally {
    clearTimeout(timer);
  }
}

class JsonlLeadOutbox {
  constructor({ outboxPath, dlqPath }) {
    this.outboxPath = outboxPath;
    this.dlqPath = dlqPath;
  }

  async _append(filePath, record) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  async enqueue(event) {
    await this._append(this.outboxPath, { op: 'enqueue', at: new Date().toISOString(), event });
  }

  async _states() {
    let content = '';
    try {
      content = await fsp.readFile(this.outboxPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return new Map();
      throw error;
    }
    const states = new Map();
    for (const line of content.split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      const id = row.event?.intake_id;
      if (!id) continue;
      const state = states.get(id) || { event: row.event, status: 'PENDING', attempts: 0 };
      if (row.op === 'enqueue') state.event = row.event;
      if (row.op === 'delivered') state.status = 'DELIVERED';
      if (row.op === 'failed') {
        state.attempts = Number(row.attempts || state.attempts + 1);
        state.status = row.dead_letter ? 'DLQ' : 'PENDING';
      }
      states.set(id, state);
    }
    return states;
  }

  async findByIdempotencyKey(key) {
    for (const state of (await this._states()).values()) {
      if (state.event?.idempotency_key === key) return state.event;
    }
    return null;
  }

  async pending() {
    return (await this.pendingStates()).map(state => state.event);
  }

  async pendingStates() {
    return [...(await this._states()).values()]
      .filter(state => state.status === 'PENDING')
      .map(state => ({ event: state.event, attempts: state.attempts }));
  }

  async markDelivered(event) {
    await this._append(this.outboxPath, { op: 'delivered', at: new Date().toISOString(), event });
  }

  async markFailed(event, attempts, error, maxAttempts) {
    const deadLetter = attempts >= maxAttempts;
    const record = {
      op: 'failed',
      at: new Date().toISOString(),
      event,
      attempts,
      dead_letter: deadLetter,
      error: String(error || 'delivery failed').slice(0, 500)
    };
    await this._append(this.outboxPath, record);
    if (deadLetter) await this._append(this.dlqPath, record);
  }
}

function createHttpPublisher(config, fetchImpl = globalThis.fetch) {
  return async event => {
    if (!config.targetUrl) {
      if (config.production) throw fail('线索投递目标未配置', 503);
      return { dry_run: true };
    }
    if (typeof fetchImpl !== 'function') throw fail('线索投递客户端不可用', 503);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.targetTimeoutMs);
    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-Contract-Version': PUBLIC_LEAD_CONTRACT,
        'X-Idempotency-Key': event.idempotency_key
      };
      // EDP 的官网入口使用 X-API-Key 认证；不要把 API Key 伪装成浏览器 JWT。
      if (config.targetToken) headers['X-API-Key'] = config.targetToken;
      const response = await fetchImpl(config.targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`target status ${response.status}`);
      return { delivered: true };
    } finally {
      clearTimeout(timer);
    }
  };
}

function createPublicLeadService({ config, outbox, publisher, captchaVerifier = verifyCaptcha, limiter } = {}) {
  const rateLimiter = limiter || createRateLimiter({ windowMs: config.rateLimitWindowMs, max: config.rateLimitMax });
  return {
    async submit({ body, origin, clientKey, captchaToken, idempotencyKey }) {
      if (!allowedOrigin(origin, config.allowedOrigins)) throw fail('来源不被允许', 403);
      if (!rateLimiter.allow(clientKey || 'unknown')) throw fail('请求过于频繁，请稍后再试', 429);
      await captchaVerifier({ token: captchaToken, clientKey, config });
      const effectiveBody = { ...body, idempotency_key: idempotencyKey || body?.idempotency_key };
      const normalizedKey = normalizeIdempotencyKey(effectiveBody.idempotency_key);
      const existing = await outbox.findByIdempotencyKey(normalizedKey);
      if (existing) return { lead_reference: existing.intake_id, deduplicated: true };
      const event = normalizePublicLead(effectiveBody, config);
      await outbox.enqueue(event);
      try {
        await publisher(event);
        await outbox.markDelivered(event);
      } catch (error) {
        await outbox.markFailed(event, 1, error.message, config.maxAttempts);
      }
      return { lead_reference: event.intake_id, deduplicated: false };
    },
    async flush() {
      for (const state of await outbox.pendingStates()) {
        const event = state.event;
        try {
          await publisher(event);
          await outbox.markDelivered(event);
        } catch (error) {
          const attempts = state.attempts + 1;
          await outbox.markFailed(event, attempts, error.message, config.maxAttempts);
        }
      }
    },
    rateLimiter
  };
}

module.exports = {
  JsonlLeadOutbox,
  PUBLIC_LEAD_CONTRACT,
  PUBLIC_LEAD_PATH,
  allowedOrigin,
  createHttpPublisher,
  createPublicLeadConfig,
  createPublicLeadService,
  createRateLimiter,
  normalizeIdempotencyKey,
  normalizePublicLead,
  verifyCaptcha
};
