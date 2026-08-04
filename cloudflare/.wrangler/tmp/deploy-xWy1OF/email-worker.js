var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// email-worker.js
function collectHeaders(headers) {
  const out = {};
  for (const [key, value] of headers) {
    const name = key.toLowerCase();
    out[name] = out[name] ? `${out[name]} ${value}` : value;
  }
  return out;
}
__name(collectHeaders, "collectHeaders");
function extractText(raw) {
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  if (boundaryMatch) {
    const parts = raw.split(`--${boundaryMatch[1]}`);
    for (const part of parts) {
      if (!/content-type:\s*text\/plain/i.test(part)) continue;
      const split2 = part.indexOf("\r\n\r\n");
      const body = split2 >= 0 ? part.slice(split2 + 4) : part;
      if (/content-transfer-encoding:\s*base64/i.test(part)) {
        try {
          return atob(body.replace(/\s+/g, ""));
        } catch {
        }
      }
      if (/content-transfer-encoding:\s*quoted-printable/i.test(part)) {
        return body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      }
      return body.trim();
    }
  }
  const split = raw.indexOf("\r\n\r\n");
  return split >= 0 ? raw.slice(split + 4).trim() : raw;
}
__name(extractText, "extractText");
var email_worker_default = {
  async email(message, env) {
    if (env.FORWARD_TO) {
      try {
        await message.forward(env.FORWARD_TO);
      } catch (error) {
        console.error("forward failed:", error?.message ?? error);
      }
    }
    if (!env.CRM_INBOUND_URL || !env.CRM_INBOUND_SECRET) {
      console.error("CRM_INBOUND_URL or CRM_INBOUND_SECRET is not set; message not delivered to the CRM");
      return;
    }
    let raw = "";
    try {
      raw = await new Response(message.raw).text();
    } catch (error) {
      console.error("could not read raw message:", error?.message ?? error);
    }
    const headers = collectHeaders(message.headers);
    const payload = {
      from: headers.from || message.from,
      to: headers.to || message.to,
      subject: headers.subject || "",
      text: extractText(raw).slice(0, 1e5),
      headers
    };
    const response = await fetch(env.CRM_INBOUND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.CRM_INBOUND_SECRET}`
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`CRM rejected the message: ${response.status} ${detail.slice(0, 300)}`);
    }
  }
};
export {
  email_worker_default as default
};
//# sourceMappingURL=email-worker.js.map
