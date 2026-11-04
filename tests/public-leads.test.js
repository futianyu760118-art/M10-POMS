'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  JsonlLeadOutbox,
  allowedOrigin,
  createHttpPublisher,
  createPublicLeadConfig,
  createPublicLeadService,
  createRateLimiter,
  normalizePublicLead
} = require('../apps/bff/public-leads');

const origin = 'https://150.158.13.110';

function tempFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm10-public-leads-'));
  return { outboxPath: path.join(dir, 'outbox.jsonl'), dlqPath: path.join(dir, 'dlq.jsonl') };
}

async function main() {
  const config = createPublicLeadConfig({
    NODE_ENV: 'test',
    PUBLIC_BFF_ALLOWED_ORIGINS: 'https://150.158.13.110',
    PUBLIC_BFF_TENANT_ID: 'tenant-a'
  });
  const event = normalizePublicLead({
    name: '张三', email: 'Test@Example.com', phone: '13800138000', interest: '工业照明',
    message: '需要一套方案', consent: { granted: true, version: 'privacy-2026-01', purpose: '业务联系' }
  }, config, new Date('2026-11-01T00:00:00.000Z'));
  assert.equal(event.source_system, 'PUBLIC_BFF');
  assert.equal(event.contact.email_or_phone, 'test@example.com');
  assert.equal(event.consent.retention_until, '2028-10-31T00:00:00.000Z');
  assert.equal(allowedOrigin('https://150.158.13.110', config.allowedOrigins), true);
  assert.equal(allowedOrigin('https://evil.example', config.allowedOrigins), false);

  let targetRequest;
  await createHttpPublisher({
    targetUrl: 'https://edp.example/api/v1/public/lead-intake',
    targetToken: 'edp-api-key',
    targetTimeoutMs: 1000
  }, async (url, options) => {
    targetRequest = { url, options };
    return { ok: true, status: 202 };
  })({ intake_id: 'lead_test', idempotency_key: 'web-001' });
  assert.equal(targetRequest.url, 'https://edp.example/api/v1/public/lead-intake');
  assert.equal(targetRequest.options.headers['X-API-Key'], 'edp-api-key');
  assert.equal(targetRequest.options.headers.Authorization, undefined);

  assert.throws(() => normalizePublicLead({ name: '张三', phone: '13800138000', interest: 'x', consent: { granted: true } }, config), /隐私/);
  assert.throws(() => normalizePublicLead({ name: '张三', email: 'bad', interest: 'x', consent: { granted: true, version: 'v', purpose: 'p' } }, config), /邮箱/);

  let now = 0;
  const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: () => now });
  assert.equal(limiter.allow('ip-a'), true);
  assert.equal(limiter.allow('ip-a'), true);
  assert.equal(limiter.allow('ip-a'), false);
  now = 1001;
  assert.equal(limiter.allow('ip-a'), true);

  const files = tempFiles();
  const outbox = new JsonlLeadOutbox(files);
  const service = createPublicLeadService({
    config,
    outbox,
    limiter: createRateLimiter({ max: 20 }),
    captchaVerifier: async () => {},
    publisher: async () => {}
  });
  const body = { name: '李四', phone: '13900139000', interest: '电源', consent: { granted: true, version: 'v1', purpose: '报价' } };
  const first = await service.submit({ body, origin: 'https://150.158.13.110', clientKey: 'ip-b', idempotencyKey: 'web-001' });
  const second = await service.submit({ body, origin: 'https://150.158.13.110', clientKey: 'ip-b', idempotencyKey: 'web-001' });
  assert.equal(first.deduplicated, false);
  assert.deepEqual(second, { lead_reference: first.lead_reference, deduplicated: true });
  assert.equal((await outbox.pending()).length, 0);
  fs.rmSync(path.dirname(files.outboxPath), { recursive: true, force: true });

  assert.throws(() => createPublicLeadConfig({ NODE_ENV: 'production', PUBLIC_BFF_ALLOWED_ORIGINS: '*' }), /通配符/);

  const failedFiles = tempFiles();
  const failedConfig = createPublicLeadConfig({ NODE_ENV: 'test', PUBLIC_BFF_ALLOWED_ORIGINS: origin, PUBLIC_BFF_MAX_ATTEMPTS: '2' });
  const failedOutbox = new JsonlLeadOutbox(failedFiles);
  const failedService = createPublicLeadService({
    config: failedConfig,
    outbox: failedOutbox,
    limiter: createRateLimiter({ max: 20 }),
    captchaVerifier: async () => {},
    publisher: async () => { throw new Error('target unavailable'); }
  });
  const failedFirst = await failedService.submit({ body, origin, clientKey: 'ip-c', idempotencyKey: 'dlq-001' });
  assert.equal((await failedOutbox.pending()).length, 1);
  await failedService.flush();
  assert.equal((await failedOutbox.pending()).length, 0);
  assert.equal((await failedOutbox.findByIdempotencyKey('dlq-001')).intake_id, failedFirst.lead_reference);
  assert.equal(fs.readFileSync(failedFiles.dlqPath, 'utf8').split('\n').filter(Boolean).length, 1);
  fs.rmSync(path.dirname(failedFiles.outboxPath), { recursive: true, force: true });

  assert.throws(() => createPublicLeadConfig({ NODE_ENV: 'production', PUBLIC_BFF_ALLOWED_ORIGINS: 'https://public.example', PUBLIC_BFF_TARGET_URL: 'https://edp.example/intake', PUBLIC_BFF_CAPTCHA_MODE: 'provider', PUBLIC_BFF_CAPTCHA_VERIFY_URL: 'https://captcha.example/verify', PUBLIC_BFF_TENANT_ID: 'tenant-a' }), /服务令牌/);
  console.log('Public Lead BFF: 16 checks passed');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
