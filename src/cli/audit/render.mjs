// Renders an audit folder's findings.json as report.html. Usage: node render.mjs [<audit dir>]
// The directory defaults to the folder this file is in. report.md stays the evidence log; report.html is the
// one-screen read: findings ranked by high-end $, one fix each with a copy button, evidence collapsed.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url)));

function fail(msg) {
  console.error(`render.mjs: ${msg}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(path.join(dir, "findings.json"), "utf8"));
} catch (e) {
  fail(`cannot read findings.json in ${dir}: ${e.message}`);
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string";
const need = (ok, field) => {
  if (!ok) fail(`findings.json: ${field} is missing or has the wrong type`);
};
need(data && typeof data === "object", "(root)");
need(isStr(data.window?.start) && isStr(data.window?.end), "window.start/end");
need(isNum(data.total_spend_usd), "total_spend_usd");
need(Array.isArray(data.findings), "findings");
need(data.nothing_found === undefined || Array.isArray(data.nothing_found), "nothing_found");
(data.nothing_found ?? []).forEach((n, i) =>
  need(n && typeof n === "object", `nothing_found[${i}]`),
);
data.findings.forEach((f, i) => {
  const at = `findings[${i}]`;
  need(f && typeof f === "object", at);
  need(isStr(f.title), `${at}.title`);
  need(isNum(f.instances), `${at}.instances`);
  need(f.usd_low === null || isNum(f.usd_low), `${at}.usd_low`);
  need(f.usd_high === null || isNum(f.usd_high), `${at}.usd_high`);
  need(isStr(f.method), `${at}.method`);
  need(f.fix && isStr(f.fix.type) && isStr(f.fix.content), `${at}.fix`);
  need(f.evidence === undefined || Array.isArray(f.evidence), `${at}.evidence`);
  (f.evidence ?? []).forEach((e, j) => need(e && typeof e === "object", `${at}.evidence[${j}]`));
});

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const usd = (n) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n) => Math.round(n).toLocaleString("en-US");
const range = (f) =>
  isNum(f.usd_high) ? `${usd(f.usd_low ?? 0)}–${usd(f.usd_high)}` : "not priced";
const pct = (f) =>
  isNum(f.usd_high) && data.total_spend_usd > 0
    ? `${((100 * f.usd_high) / data.total_spend_usd).toFixed(1)}%`
    : "—";

// Priced findings by high-end $; unpriced (broken) ones after, by instance count.
const ranked = [...data.findings].sort((a, b) => {
  const pa = isNum(a.usd_high);
  const pb = isNum(b.usd_high);
  if (pa !== pb) return pa ? -1 : 1;
  return pa ? b.usd_high - a.usd_high : b.instances - a.instances;
});

const rows = ranked
  .map(
    (f, i) =>
      `<tr><td>${i + 1}</td><td><a href="#f${i + 1}">${esc(f.title)}</a>${
        f.signal ? ` <span class="muted">${esc(f.signal)}</span>` : ""
      }</td><td class="num">${int(f.instances)}</td><td class="num">${range(f)}</td><td class="num">${pct(
        f,
      )}</td><td>${esc(f.fix.type)}</td></tr>`,
  )
  .join("\n");

const sections = ranked
  .map((f, i) => {
    const ev = (f.evidence ?? [])
      .map(
        (e) =>
          `<h4>${esc(e.label)}</h4>${e.query ? `<pre>${esc(e.query)}</pre>` : ""}${
            e.output ? `<pre>${esc(e.output)}</pre>` : ""
          }`,
      )
      .join("\n");
    return `<section class="card" id="f${i + 1}">
<h2>${i + 1}. ${esc(f.title)}${f.signal ? ` <span class="muted">${esc(f.signal)}</span>` : ""}</h2>
<p class="meta">${int(f.instances)} instances · ${range(f)} (${pct(f)} of spend) · ${esc(
      f.verified_by ?? "",
    )}${f.low_n ? " · low-N" : ""}</p>
<p>${esc(f.method)}</p>
<div class="fix"><div class="fixhead"><strong>Fix (${esc(f.fix.type)})</strong>${
      f.fix.summary ? ` ${esc(f.fix.summary)}` : ""
    }<button type="button" data-copy="fix${i + 1}">Copy</button></div>
<pre id="fix${i + 1}">${esc(f.fix.content)}</pre></div>
<details><summary>Evidence (${(f.evidence ?? []).length})</summary>
${ev}
</details>
</section>`;
  })
  .join("\n");

const nothing = (data.nothing_found ?? [])
  .map((n) => `<li><strong>${esc(n.signal)} ${esc(n.name)}</strong>: ${esc(n.note)}</li>`)
  .join("\n");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code spend audit</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--code:#f5f5f4;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--code:#0c0a09;--accent:#60a5fa}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0 0 6px}h4{margin:12px 0 4px;font-size:13px}
a{color:var(--accent)}.muted,.meta{color:var(--muted)}.meta{font-size:13px;margin:0 0 8px}
table{width:100%;border-collapse:collapse;margin:16px 0}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
.num{text-align:right;white-space:nowrap}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin:16px 0}
pre{background:var(--code);padding:10px;border-radius:6px;overflow-x:auto;font-size:12.5px;white-space:pre-wrap;word-break:break-word}
.fixhead{display:flex;gap:8px;align-items:baseline}.fixhead button{margin-left:auto}
button{font:inherit;font-size:13px;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}
summary{cursor:pointer;color:var(--muted)}
.wrap{overflow-x:auto}
</style></head><body><main>
<h1>Claude Code spend audit</h1>
<p class="muted">Window ${esc(data.window.start)} – ${esc(data.window.end)} · Total spend ${usd(
  data.total_spend_usd,
)}${data.pricing_basis ? ` (${esc(data.pricing_basis)})` : ""}${
  isNum(data.turns) ? ` · ${int(data.turns)} turns` : ""
} · details and queries in report.md</p>
<div class="wrap"><table><thead><tr><th>#</th><th>Finding</th><th class="num">Instances</th><th class="num">$ range</th><th class="num">% of spend</th><th>Fix</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
${sections}
${nothing ? `<section class="card"><h2>Checked, nothing found</h2><ul>\n${nothing}\n</ul></section>` : ""}
</main>
<script>
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-copy]");
  if (!b) return;
  const text = document.getElementById(b.dataset.copy).textContent;
  const done = () => { b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500); };
  navigator.clipboard.writeText(text).then(done, () => {
    const r = document.createRange();
    r.selectNodeContents(document.getElementById(b.dataset.copy));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    document.execCommand("copy");
    done();
  });
});
</script>
</body></html>
`;

fs.writeFileSync(path.join(dir, "report.html"), html);
console.log(`Wrote ${path.join(dir, "report.html")}`);
