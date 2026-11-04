const DEFAULT_ENDPOINT = '/api/v1/public/leads';
const DEFAULT_CONSENT_VERSION = 'aizhiyun-privacy-2026-11';
const DEFAULT_CONSENT_PURPOSE = 'AEOS 官网业务咨询';

function field(form, name) {
  return form?.elements?.namedItem?.(name) || null;
}

function value(form, name) {
  return String(field(form, name)?.value || '').trim();
}

function required(valueToCheck, message) {
  if (!valueToCheck) throw new Error(message);
  return valueToCheck;
}

function buildPublicLeadPayload(
  form,
  { consentVersion = DEFAULT_CONSENT_VERSION, consentPurpose = DEFAULT_CONSENT_PURPOSE } = {}
) {
  const name = required(value(form, 'name'), '请填写姓名');
  const email = value(form, 'email');
  const phone = value(form, 'phone');
  if (!email && !phone) throw new Error('请至少填写邮箱或手机号');

  const consent = field(form, 'privacy_consent') || field(form, 'consent');
  if (!consent?.checked) throw new Error('请先勾选隐私同意');

  return {
    name,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    interest: required(value(form, 'interest'), '请选择咨询方向'),
    ...(value(form, 'message') ? { message: value(form, 'message') } : {}),
    consent: {
      granted: true,
      version: consentVersion,
      purpose: consentPurpose
    }
  };
}

function randomId(uuid) {
  if (typeof uuid === 'function') return uuid();
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error('当前浏览器不支持安全的幂等键生成');
}

async function submitPublicLead(
  form,
  {
    endpoint = DEFAULT_ENDPOINT,
    fetchImpl = globalThis.fetch,
    locationProtocol = globalThis.location?.protocol,
    uuid,
    ...payloadOptions
  } = {}
) {
  if (locationProtocol === 'file:') throw new Error('官网必须通过 HTTP(S) 地址访问，不能使用 file://');
  if (locationProtocol && !['http:', 'https:'].includes(locationProtocol)) {
    throw new Error('官网访问协议不受支持');
  }
  if (typeof fetchImpl !== 'function') throw new Error('线索提交服务不可用');

  const payload = buildPublicLeadPayload(form, payloadOptions);
  const idempotencyKey = `web_${randomId(uuid)}`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(payload)
  });
  let body = null;
  try { body = await response.json(); } catch { /* 不读取或回显异常响应正文 */ }
  if (!response.ok) {
    throw new Error(response.status === 429 ? '提交过于频繁，请稍后再试' : '提交失败，请稍后重试');
  }
  if (!body || typeof body.lead_reference !== 'string' || !body.lead_reference) {
    throw new Error('服务返回格式无效，请稍后重试');
  }
  return { lead_reference: body.lead_reference, deduplicated: body.deduplicated === true };
}

function bindPublicLeadForm(form, { statusElement, submitButton, ...options } = {}) {
  if (!form) throw new Error('找不到官网线索表单');
  const status = statusElement || form.querySelector?.('[role="status"]');
  const button = submitButton || form.querySelector?.('button[type="submit"]');
  const listener = async event => {
    event.preventDefault();
    if (button) button.disabled = true;
    if (status) status.textContent = '正在安全提交…';
    try {
      await submitPublicLead(form, options);
      if (status) status.textContent = '已收到你的需求，我们会尽快联系你。';
      form.dispatchEvent?.(new CustomEvent('aeos:lead-submitted', { bubbles: true }));
    } catch (error) {
      if (status) status.textContent = error instanceof Error ? error.message : '提交失败，请稍后重试';
    } finally {
      if (button) button.disabled = false;
    }
  };
  form.addEventListener('submit', listener);
  return () => form.removeEventListener('submit', listener);
}

export {
  DEFAULT_CONSENT_PURPOSE,
  DEFAULT_CONSENT_VERSION,
  DEFAULT_ENDPOINT,
  bindPublicLeadForm,
  buildPublicLeadPayload,
  submitPublicLead
};
