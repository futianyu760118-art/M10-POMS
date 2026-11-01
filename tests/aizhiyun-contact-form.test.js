'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function loadModule() {
  return import('../integrations/aizhiyun/contact-form.mjs');
}

function fakeForm(values, { consent = true } = {}) {
  const fields = new Map(Object.entries(values).map(([name, value]) => [name, { value }]));
  fields.set('privacy_consent', { checked: consent, value: 'on' });
  return {
    elements: { namedItem: name => fields.get(name) },
    addEventListener() {},
    removeEventListener() {}
  };
}

test('AIZHIYUN form maps only the public LeadIntake fields', async () => {
  const { buildPublicLeadPayload } = await loadModule();
  const payload = buildPublicLeadPayload(fakeForm({
    name: '张三',
    email: 'sales@example.com',
    phone: '13800138000',
    interest: 'AEOS 整体方案',
    message: '希望先梳理订单协同。',
    internal_note: 'must not be forwarded'
  }));

  assert.deepEqual(payload, {
    name: '张三',
    email: 'sales@example.com',
    phone: '13800138000',
    interest: 'AEOS 整体方案',
    message: '希望先梳理订单协同。',
    consent: { granted: true, version: 'aizhiyun-privacy-2026-11', purpose: 'AEOS 官网业务咨询' }
  });
});

test('AIZHIYUN form requires explicit privacy consent', async () => {
  const { buildPublicLeadPayload } = await loadModule();
  assert.throws(
    () => buildPublicLeadPayload(fakeForm({ name: '李四', email: 'li@example.com', interest: 'AI 中枢' }, { consent: false })),
    /隐私同意/
  );
});

test('submitPublicLead blocks file URLs and sends idempotency without credentials', async () => {
  const { submitPublicLead } = await loadModule();
  const form = fakeForm({ name: '王五', email: 'wang@example.com', interest: 'AI 港湾' });
  let called = false;
  await assert.rejects(
    submitPublicLead(form, {
      locationProtocol: 'file:',
      fetchImpl: async () => { called = true; }
    }),
    /HTTP\(S\)/
  );
  assert.equal(called, false);
});

test('submitPublicLead posts the public payload and returns opaque reference', async () => {
  const { submitPublicLead } = await loadModule();
  const form = fakeForm({ name: '赵六', email: 'zhao@example.com', interest: 'AI 小队' });
  let request;
  const result = await submitPublicLead(form, {
    endpoint: 'https://public.example/api/v1/public/leads',
    locationProtocol: 'https:',
    uuid: () => 'lead-key-001',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 202, json: async () => ({ lead_reference: 'lead_opaque_001' }) };
    }
  });

  assert.deepEqual(result, { lead_reference: 'lead_opaque_001', deduplicated: false });
  assert.equal(request.url, 'https://public.example/api/v1/public/leads');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.headers['Idempotency-Key'], 'web_lead-key-001');
  assert.equal(JSON.parse(request.options.body).email, 'zhao@example.com');
});
