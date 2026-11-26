// Small, safe Markdown -> HTML renderer for generated articles.
// Supports: #-###### headings, paragraphs, - / 1. lists, > quotes, ``` code, | tables |, **bold**, *italic*, `code`, [links](url).
// All text is HTML-escaped; only http(s) and relative links are allowed.
export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function slugify(s) {
  return String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "article";
}

function safeHref(url) {
  const u = String(url).trim();
  if (/^https?:\/\//i.test(u) || u.startsWith("/") || u.startsWith("#")) return u;
  return null;
}

function inline(text) {
  let out = "";
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const href = safeHref(m[2]);
      const ext = /^https?:\/\//i.test(m[2]);
      out += href ? `<a href="${esc(href)}"${ext ? ' rel="noopener"' : ""}>${inline(m[1])}</a>` : esc(m[1]);
    } else if (m[3] !== undefined) out += `<strong>${inline(m[3])}</strong>`;
    else if (m[4] !== undefined) out += `<em>${inline(m[4])}</em>`;
    else if (m[5] !== undefined) out += `<code>${esc(m[5])}</code>`;
    last = re.lastIndex;
  }
  return out + esc(text.slice(last));
}

export function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let i = 0;
  const headingIds = new Set();
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      html.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      let id = slugify(h[2]); while (headingIds.has(id)) id += "-x"; headingIds.add(id);
      html.push(`<h${level} id="${id}">${inline(h[2].trim())}</h${level}>`);
      i++; continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = row(line); i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      html.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      html.push(`<blockquote><p>${inline(buf.join(" "))}</p></blockquote>`);
      continue;
    }
    const ul = /^\s*[-*+]\s+/, ol = /^\s*\d+[.)]\s+/;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line), re = ordered ? ol : ul, items = [];
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ""));
      html.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) buf.push(lines[i++].trim());
    html.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return html.join("\n");
}

/** FAQ pairs from a "## FAQ" section: ### question followed by answer paragraphs. */
export function extractFaq(md) {
  const m = String(md).match(/^##\s+(?:FAQs?|Frequently asked questions|Preguntas frecuentes|FAQ)[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im);
  if (!m) return [];
  const out = [];
  for (const block of m[1].split(/^###\s+/m).slice(1)) {
    const [q, ...rest] = block.split("\n");
    const a = rest.join(" ").replace(/\s+/g, " ").trim();
    if (q.trim() && a) out.push({ question: q.trim().replace(/\*\*/g, ""), answer: a.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*`]/g, "") });
  }
  return out.slice(0, 10);
}

export const plainText = (md) => String(md).replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[#>*`|_-]/g, " ").replace(/\s+/g, " ").trim();
