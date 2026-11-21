'use strict';
// Messaging + social publishing adapters. Every adapter reports isConfigured();
// callers MUST refuse to send when an adapter is not configured. Nothing here
// fabricates a success: a status is only "sent" when the provider accepts the
// request, and only "delivered" when a provider delivery report (webhook) says so.

const env = (k) => (process.env[k] || '').trim();

function normaliseIndianMobile(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return '91' + d;
  if (d.length === 12 && d.startsWith('91')) return d;
  if (d.length === 11 && d.startsWith('0')) return '91' + d.slice(1);
  return null;
}

function render(body, vars) {
  return String(body).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? ''));
}

// ---------- SMS: MSG91 Flow API (DLT-registered templates) ----------
const sms = {
  name: 'msg91',
  isConfigured() { return !!env('MSG91_AUTHKEY'); },
  missing() { return ['MSG91_AUTHKEY'].filter((k) => !env(k)); },
  /** template: row from sms_templates; vars: object; to: 91XXXXXXXXXX */
  async send({ template, to, vars }) {
    if (!this.isConfigured()) throw new ProviderError('SMS provider not configured (MSG91_AUTHKEY missing).', 'not_configured');
    if (!template.provider_template_id) throw new ProviderError('Template has no MSG91 template/flow ID.', 'template_invalid');
    if (!template.dlt_template_id || !template.sender_id) throw new ProviderError('Template is missing its DLT template ID or sender ID.', 'template_invalid');
    const recipient = { mobiles: to };
    for (const [k, v] of Object.entries(vars)) recipient[k] = String(v ?? '');
    const res = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: { authkey: env('MSG91_AUTHKEY'), accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ template_id: template.provider_template_id, sender: template.sender_id, short_url: '0', recipients: [recipient] }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.type !== 'success') throw new ProviderError('MSG91 rejected the message: ' + (data.message || res.status), 'rejected');
    return { providerMessageId: String(data.message || data.request_id || ''), status: 'sent' };
  }
};

// ---------- WhatsApp Cloud API (approved template messages) ----------
const whatsapp = {
  name: 'whatsapp_cloud',
  isConfigured() { return !!(env('WA_TOKEN') && env('WA_PHONE_NUMBER_ID')); },
  missing() { return ['WA_TOKEN', 'WA_PHONE_NUMBER_ID'].filter((k) => !env(k)); },
  async send({ template, to, vars }) {
    if (!this.isConfigured()) throw new ProviderError('WhatsApp Business API not configured.', 'not_configured');
    if (!template.wa_template_name) throw new ProviderError('Template has no approved WhatsApp template name.', 'template_invalid');
    const order = JSON.parse(template.variables || '[]');
    const parameters = order.map((k) => ({ type: 'text', text: String(vars[k] ?? '') }));
    const res = await fetch(`https://graph.facebook.com/v21.0/${env('WA_PHONE_NUMBER_ID')}/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env('WA_TOKEN'), 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: template.wa_template_name, language: { code: template.wa_language || 'en' }, components: parameters.length ? [{ type: 'body', parameters }] : [] } }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.messages?.[0]?.id) throw new ProviderError('WhatsApp API rejected the message: ' + (data.error?.message || res.status), 'rejected');
    return { providerMessageId: data.messages[0].id, status: 'sent' };
  }
};

// ---------- Meta (Facebook Page + Instagram) direct publishing ----------
const meta = {
  facebookConfigured() { return !!(env('META_PAGE_ID') && env('META_PAGE_TOKEN') && env('PUBLIC_BASE_URL')); },
  instagramConfigured() { return !!(env('IG_USER_ID') && env('META_PAGE_TOKEN') && env('PUBLIC_BASE_URL')); },
  async publishFacebook({ imageUrl, caption }) {
    const res = await fetch(`https://graph.facebook.com/v21.0/${env('META_PAGE_ID')}/photos`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: imageUrl, caption, access_token: env('META_PAGE_TOKEN') }), signal: AbortSignal.timeout(20000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !(data.post_id || data.id)) throw new ProviderError('Facebook rejected the post: ' + (data.error?.message || res.status), 'rejected');
    return data.post_id || data.id;
  },
  async publishInstagram({ imageUrl, caption }) {
    const base = `https://graph.facebook.com/v21.0/${env('IG_USER_ID')}`;
    const c = await fetch(`${base}/media`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image_url: imageUrl, caption, access_token: env('META_PAGE_TOKEN') }), signal: AbortSignal.timeout(20000) });
    const cd = await c.json().catch(() => ({}));
    if (!c.ok || !cd.id) throw new ProviderError('Instagram rejected the media: ' + (cd.error?.message || c.status), 'rejected');
    const p = await fetch(`${base}/media_publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ creation_id: cd.id, access_token: env('META_PAGE_TOKEN') }), signal: AbortSignal.timeout(20000) });
    const pd = await p.json().catch(() => ({}));
    if (!p.ok || !pd.id) throw new ProviderError('Instagram publish failed: ' + (pd.error?.message || p.status), 'rejected');
    return pd.id;
  }
};

class ProviderError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

function channel(name) { return name === 'whatsapp' ? whatsapp : sms; }

module.exports = { sms, whatsapp, meta, channel, render, normaliseIndianMobile, ProviderError };
