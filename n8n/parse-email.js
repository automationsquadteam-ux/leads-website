// n8n Code node — parse the model's email JSON into header / body / angle.
//
// Three passes, most reliable first:
//   1. JSON.parse as-is
//   2. JSON.parse after repair: fences off, object sliced out, raw newlines
//      inside strings escaped (the #1 reason a model's JSON fails), trailing
//      commas removed, missing commas between fields inserted
//   3. Field extraction by KEY POSITION: each value runs from after its own
//      opening quote to where the NEXT key starts — never "to the end of the
//      text", which is how the angle ended up pasted under the sign-off.
//
// Every value is then cleaned of the quote/comma/brace that closed it.

const item = $input.first().json;
const content = String(item.message?.content ?? "");

const KEYS = ["header", "body", "angle"];

function tryParse(str) {
  try {
    const parsed = JSON.parse(str);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function stripFences(text) {
  return text.replace(/```(?:json|text)?/gi, "");
}

function objectSlice(text) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return first !== -1 && last > first ? text.slice(first, last + 1) : text;
}

// Walk the text tracking whether we are inside a string literal, and escape
// the raw newlines / tabs found there. Leaves everything else untouched.
function escapeNewlinesInStrings(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function repairJson(text) {
  let s = objectSlice(stripFences(text)).trim();
  s = escapeNewlinesInStrings(s);
  // A missing comma between two fields:  "...text"\n  "angle": "..."
  s = s.replace(/"(\s*)"(header|body|angle)"\s*:/gi, '",$1"$2":');
  // Trailing comma before the closing brace
  s = s.replace(/,\s*([}\]])/g, "$1");
  return s;
}

function unescapeValue(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .trim();
}

// Peel what closed the string: quote, comma, brace, in any order, repeatedly.
// Also the model's own `sunuyoruz. ',` close — a lone single quote after
// sentence punctuation and a space (the space keeps `...said 'yes.'` intact).
function stripClosing(value) {
  let v = value;
  for (let prev = null; prev !== v; ) {
    prev = v;
    v = v.replace(/[\s,}]+$/, "").replace(/"$/, "").replace(/([.!?])\s+'$/, "$1");
  }
  return v;
}

// The language the prompt was told to write in: read from the country→language
// Code node, whatever it is called in this workflow (it is the node the
// prompt's {{ $json.language }} comes from). `.first()`, not `.item` — this
// node runs once for all items, where `.item` is not available.
function languageFromWorkflow() {
  const NODE_NAME = "Find First Pending Lead";
  try {
    return $(NODE_NAME).first().json.language || null;
  } catch {
    return null;
  }
}

function extractByPosition(text) {
  const found = [];
  for (const key of KEYS) {
    const m = new RegExp(`"${key}"\\s*:\\s*"?`, "i").exec(text);
    if (m) found.push({ key, start: m.index, valueStart: m.index + m[0].length });
  }
  found.sort((a, b) => a.start - b.start);

  const out = { header: "", body: "", angle: "" };
  found.forEach((f, i) => {
    const end = i + 1 < found.length ? found[i + 1].start : text.length;
    out[f.key] = unescapeValue(stripClosing(text.slice(f.valueStart, end)));
  });
  return out;
}

// ---------------------------------------------------------------------------

let email = tryParse(content) || tryParse(repairJson(content));

if (!email || (!email.header && !email.body)) {
  email = extractByPosition(objectSlice(stripFences(content)));
}

// Whatever path produced it, every field gets the same final clean.
for (const key of KEYS) {
  email[key] = typeof email[key] === "string" ? stripClosing(email[key]).trim() : "";
}

if (!email.header && !email.body) {
  email = { header: "Follow-up", body: content.trim(), angle: "" };
}

// A leaked sibling key inside a value means extraction still went wrong —
// report it rather than let it into the CRM.
const leaked = KEYS.some((k) => /"\s*(header|body|angle)\s*"\s*:/i.test(email[k]));

const status = leaked
  ? "Parse Error"
  : (email.header + email.body + email.angle).includes("[")
    ? "No"
    : email.header || email.body
      ? "Done"
      : "Parse Error";

return [
  {
    json: {
      header: email.header,
      body: email.body,
      angle: email.angle,
      // Map this onto email_versions.language in the insert node.
      language: languageFromWorkflow() ?? item.language ?? "en",
      status,
      timestamp: new Date().toISOString(),
    },
    // No explicit pairedItem: the node's editor typing rejects the property,
    // and with one item in and one out n8n links them itself, so downstream
    // expressions like $('Get many rows').item resolve at run time regardless
    // of what the editor preview says before the first execution.
  },
];
