const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const api = async (p, o = {}) => {
  const r = await fetch(p, { ...o, headers: { "content-type": "application/json", ...(localStorage.tok ? { authorization: "Bearer " + localStorage.tok } : {}), ...(o.headers || {}) }, body: o.body && JSON.stringify(o.body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j;
};
const fmt = (iso, tz, opt) => new Intl.DateTimeFormat([], { timeZone: tz, ...opt }).format(new Date(iso));
const full = (iso, tz) => fmt(iso, tz, { dateStyle: "full", timeStyle: "short" });
function toast(m, err) { let t = $("#toast"); if (!t) { document.body.insertAdjacentHTML("beforeend", '<div id="toast" role="status" aria-live="polite"></div>'); t = $("#toast"); } t.textContent = m; t.className = "show" + (err ? " err" : ""); clearTimeout(t._h); t._h = setTimeout(() => t.className = "", 3500); }
function tzSelect(el, cur, onchange) {
  const z = Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : []; if (!z.includes(cur)) z.unshift(cur);
  el.innerHTML = z.map(x => `<option${x === cur ? " selected" : ""}>${x}</option>`).join(""); el.onchange = () => onchange(el.value);
}
/** Month calendar + time list. Dates with no slots are disabled; fully keyboard and screen-reader operable. */
function picker(el, slots, tz, pick) {
  const key = iso => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
  const by = {}; slots.forEach(s => (by[key(s.start)] ??= []).push(s)); const keys = Object.keys(by).sort();
  if (!keys.length) { el.innerHTML = '<p class="muted">No available times in this period.</p>'; return; }
  let [y, m] = keys[0].split("-").map(Number); m--; let sel = null;
  const draw = () => {
    const first = new Date(Date.UTC(y, m, 1)), days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    let h = `<div class="pickgrid"><div><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem"><button id="pv" aria-label="Previous month">&lsaquo;</button><b>${first.toLocaleString([], { month: "long", year: "numeric", timeZone: "UTC" })}</b><button id="nx" aria-label="Next month">&rsaquo;</button></div><div class="cal">` + ["S", "M", "T", "W", "T", "F", "S"].map(d => `<span class="dow" aria-hidden="true">${d}</span>`).join("") + "<span></span>".repeat(first.getUTCDay());
    for (let d = 1; d <= days; d++) { const k = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`; h += `<button data-k="${k}" aria-pressed="${k === sel}" ${by[k] ? "" : "disabled"} aria-label="${k}${by[k] ? ", times available" : ", unavailable"}">${d}</button>`; }
    h += `</div></div><div><b>${sel ? fmt(by[sel][0].start, tz, { weekday: "long", month: "short", day: "numeric" }) : "Select a date"}</b><div class="times" role="group" aria-label="Available times">` + (sel ? by[sel].map((s, i) => `<button data-i="${i}">${fmt(s.start, tz, { hour: "numeric", minute: "2-digit" })}${s.remaining > 1 ? ` · ${s.remaining} left` : ""}</button>`).join("") : "") + "</div></div></div>";
    el.innerHTML = h;
    el.querySelector("#pv").onclick = () => { m--; if (m < 0) { m = 11; y--; } draw(); };
    el.querySelector("#nx").onclick = () => { m++; if (m > 11) { m = 0; y++; } draw(); };
    el.querySelectorAll(".cal [data-k]").forEach(b => b.onclick = () => { sel = b.dataset.k; draw(); el.querySelector(`[data-k="${sel}"]`).focus(); });
    el.querySelectorAll(".times [data-i]").forEach(b => b.onclick = () => pick(by[sel][+b.dataset.i]));
  };
  draw();
}
if (location.search.includes("embed=1")) document.documentElement.classList.add("embed");
document.addEventListener("DOMContentLoaded", () => document.body.insertAdjacentHTML("afterbegin", '<header class="nav"><a class="brand" href="/"><span class="logo"></span>Slotbook</a><nav><a href="/">Home</a><a href="/demo">Demo host</a><a href="/host">Host dashboard</a></nav></header>'));
