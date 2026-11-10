// Plan connector: a small MCP server that lets Claude (in the Claude app) read and change your Plan schedule.
// Runs as a Supabase Edge Function. Deploy with "Verify JWT" turned OFF: the secret link itself is the sign-in.
// Connector URL: https://<project>.supabase.co/functions/v1/plan-mcp/<secret from the app's Claude tab>
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

// ==== CORE START (no Supabase or Deno below this line until CORE END, so it can be tested on its own) ====
const SERVER_INFO = { name: "plan", title: "Plan", version: "1.0.0" };
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PRIORITY_IN = { low: 1, normal: 2, high: 3 };
const PRIORITY_OUT = { 1: "low", 2: "normal", 3: "high" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INSTRUCTIONS = `This connector is the user's day planner ("Plan"). The Plan app on their phone shows today's hour-by-hour schedule and the next few days.
How to use it:
- Call get_schedule first, every time, to see today's date, the current time in the user's time zone, their preferences and what is already planned. Never guess the date.
- When the user tells you about plans, deadlines or things to do, add or move blocks so the schedule reflects it. Use add_tasks for new items and update_tasks to move, edit or complete existing ones.
- "fixed" blocks (classes, shifts, appointments, exams) must not be moved or shortened unless the user asks. "flexible" blocks can be rearranged.
- Keep blocks inside the user's day_start/day_end, avoid overlaps, put demanding work in their focus hours, and leave short breaks between long blocks.
- For a deadline, plan work sessions backwards from the due date instead of one huge block the day before.
- Things with no time go on a day with no start (anytime). Things with no day go to someday (date null).
- After changing anything, tell the user briefly what you changed. Every change is logged in the app with an Undo button.
- Don't delete things the user didn't ask to remove; mark finished things done instead.`;

const TASK_FIELDS = {
  title: { type: "string", minLength: 1, maxLength: 200, description: "Short name, e.g. \"Study for STATS midterm\"." },
  date: { type: ["string", "null"], description: "Day as YYYY-MM-DD in the user's time zone, or null for someday (no day yet)." },
  start: { type: ["string", "null"], description: "Start time HH:MM (24-hour), or null for anytime that day." },
  duration_min: { type: "integer", minimum: 5, maximum: 1440, description: "Length in minutes." },
  kind: { type: "string", enum: ["fixed", "flexible"], description: "fixed = class, shift, appointment, exam (don't move it). flexible = can be rearranged." },
  priority: { type: "string", enum: ["low", "normal", "high"] },
  due: { type: ["string", "null"], description: "Deadline as YYYY-MM-DD, or null." },
  notes: { type: "string", maxLength: 2000 },
};

const TOOLS = [
  {
    name: "get_schedule",
    title: "Get schedule",
    description: "Read the user's schedule: today's date and current time in their time zone, their planning preferences, the blocks on each day in a range, unfinished tasks left over from earlier days, and someday tasks with no day yet. Call this before making any change.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      start_date: { type: "string", description: "First day to include, YYYY-MM-DD. Defaults to today." },
      days: { type: "integer", minimum: 1, maximum: 31, description: "How many days to include. Defaults to 7." },
      include_done: { type: "boolean", description: "Include finished tasks. Defaults to true for today only." },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "add_tasks",
    title: "Add to schedule",
    description: "Add one or more blocks or tasks to the schedule. Each needs a title; give a date (or null for someday) and a start time (or null for anytime). Returns the new tasks with their ids and any overlaps it notices.",
    inputSchema: { type: "object", additionalProperties: false, required: ["tasks"], properties: {
      tasks: { type: "array", minItems: 1, maxItems: 25, items: { type: "object", additionalProperties: false, required: ["title"], properties: TASK_FIELDS } },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "update_tasks",
    title: "Change tasks",
    description: "Move, edit or complete existing tasks by id (ids come from get_schedule). Only the fields you pass change. Set date to null to move a task to someday, start to null to make it anytime, done to true to mark it finished.",
    inputSchema: { type: "object", additionalProperties: false, required: ["updates"], properties: {
      updates: { type: "array", minItems: 1, maxItems: 25, items: { type: "object", additionalProperties: false, required: ["id"], properties: {
        id: { type: "string" }, ...TASK_FIELDS, done: { type: "boolean" },
      } } },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "delete_tasks",
    title: "Remove tasks",
    description: "Remove tasks from the schedule by id. Only when the user wants something gone (cancelled, no longer needed). For finished work, use update_tasks with done: true instead.",
    inputSchema: { type: "object", additionalProperties: false, required: ["ids"], properties: {
      ids: { type: "array", minItems: 1, maxItems: 25, items: { type: "string" } },
    } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "set_preferences",
    title: "Update planning preferences",
    description: "Save the user's planning preferences when they tell you about them: when their day starts and ends, their best focus hours, standing facts (class times, routines, rules like no work after 10pm), or their time zone. Notes replace the existing notes, so include anything worth keeping.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      day_start: { type: "string", description: "HH:MM (24-hour)." },
      day_end: { type: "string", description: "HH:MM (24-hour)." },
      focus_hours: { type: "string", maxLength: 200, description: "e.g. \"9am-12pm\"." },
      notes: { type: "string", maxLength: 2000 },
      timezone: { type: "string", description: "IANA name, e.g. America/Los_Angeles." },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

class ToolError extends Error {}
const fail = (m) => { throw new ToolError(m); };

function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function normTime(s) {
  const m = typeof s === "string" && /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s.trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return m[1].padStart(2, "0") + ":" + m[2];
}
function hm(t) { return t ? String(t).slice(0, 5) : null; }
function toMin(t) { const [h, m] = hm(t).split(":").map(Number); return h * 60 + m; }
function fromMin(n) { return String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0"); }
function addDays(s, n) { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekday(s) { return DAYS[new Date(s + "T00:00:00Z").getUTCDay()]; }
function validTz(tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }
function clockIn(tz, now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
}
function label12(t) { let [h, m] = hm(t).split(":").map(Number); const ap = h < 12 ? "AM" : "PM"; return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ap}`; }
function durLabel(n) { const h = Math.floor(n / 60), m = n % 60; return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`; }
function dayWords(d, today) {
  if (!d) return "someday";
  if (d === today) return "today";
  if (d === addDays(today, 1)) return "tomorrow";
  const dt = new Date(d + "T00:00:00Z");
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
function whenWords(t, today) { return dayWords(t.day, today) + (t.day && t.start_time ? " " + label12(t.start_time) : ""); }

function out(t) {
  const start = hm(t.start_time);
  return {
    id: t.id, title: t.title, date: t.day, start, end: start ? fromMin(Math.min(1440, toMin(start) + t.duration_min)) : null,
    duration_min: t.duration_min, kind: t.kind, priority: PRIORITY_OUT[t.priority] || "normal", due: t.due, done: t.done,
    ...(t.notes ? { notes: t.notes } : {}), added_by: t.source,
  };
}

// Turn tool input into a database row (partial for updates). Throws ToolError with a clear message on bad input.
function toRow(input, partial, where) {
  const row = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  if (!partial || has("title")) {
    const t = typeof input.title === "string" ? input.title.trim() : "";
    if (!t || t.length > 200) fail(`${where}: title must be 1-200 characters.`);
    row.title = t;
  }
  if (has("date")) {
    if (input.date !== null && !isDate(input.date)) fail(`${where}: date must be YYYY-MM-DD or null.`);
    row.day = input.date;
  } else if (!partial) row.day = null;
  if (has("start")) {
    if (input.start === null || input.start === "") row.start_time = null;
    else { const t = normTime(input.start); if (!t) fail(`${where}: start must be HH:MM (24-hour) or null.`); row.start_time = t; }
  }
  if (has("duration_min")) {
    const n = input.duration_min;
    if (!Number.isInteger(n) || n < 5 || n > 1440) fail(`${where}: duration_min must be a whole number from 5 to 1440.`);
    row.duration_min = n;
  }
  if (has("kind")) { if (!["fixed", "flexible"].includes(input.kind)) fail(`${where}: kind must be "fixed" or "flexible".`); row.kind = input.kind; }
  if (has("priority")) { if (!PRIORITY_IN[input.priority]) fail(`${where}: priority must be low, normal or high.`); row.priority = PRIORITY_IN[input.priority]; }
  if (has("due")) { if (input.due !== null && !isDate(input.due)) fail(`${where}: due must be YYYY-MM-DD or null.`); row.due = input.due; }
  if (has("notes")) { if (typeof input.notes !== "string" || input.notes.length > 2000) fail(`${where}: notes must be text up to 2000 characters.`); row.notes = input.notes; }
  if (has("done")) { if (typeof input.done !== "boolean") fail(`${where}: done must be true or false.`); row.done = input.done; row.done_at = input.done ? new Date().toISOString() : null; }
  return row;
}
function checkFits(t, where) {
  if (t.day == null) return;
  if (t.start_time && toMin(t.start_time) + t.duration_min > 1440) fail(`${where}: "${t.title}" would run past midnight. Start earlier or shorten it.`);
}
function overlaps(t, others) {
  if (!t.day || !t.start_time || t.done) return [];
  const s = toMin(t.start_time), e = s + t.duration_min;
  return others.filter(o => o.id !== t.id && o.day === t.day && o.start_time && !o.done && toMin(o.start_time) < e && s < toMin(o.start_time) + o.duration_min)
    .map(o => `"${t.title}" (${hm(t.start_time)}) overlaps "${o.title}" (${hm(o.start_time)}-${fromMin(Math.min(1440, toMin(o.start_time) + o.duration_min))}${o.kind === "fixed" ? ", fixed" : ""})`);
}
function describeUpdate(before, after, today) {
  if (!before.done && after.done) return `Marked “${after.title}” done`;
  if (before.done && !after.done) return `Marked “${after.title}” not done`;
  const moved = before.day !== after.day || hm(before.start_time) !== hm(after.start_time);
  const bits = [];
  if (before.title !== after.title) bits.push(`renamed from “${before.title}”`);
  if (before.duration_min !== after.duration_min) bits.push(durLabel(after.duration_min));
  if (before.kind !== after.kind) bits.push(after.kind);
  if (before.priority !== after.priority) bits.push((PRIORITY_OUT[after.priority] || "normal") + " priority");
  if (before.due !== after.due) bits.push(after.due ? "due " + dayWords(after.due, today) : "no due date");
  if (moved) return `Moved “${after.title}” to ${whenWords(after, today)}${bits.length ? " (" + bits.join(", ") + ")" : ""}`;
  return `Edited “${after.title}”${bits.length ? ": " + bits.join(", ") : ""}`;
}

async function profileOf(store, uid) {
  const p = await store.getProfile(uid);
  return { timezone: "America/Los_Angeles", day_start: "08:00", day_end: "23:00", focus_hours: "", notes: "", ...(p || {}), day_start: hm(p?.day_start) || "08:00", day_end: hm(p?.day_end) || "23:00" };
}

async function callTool(name, args, ctx) {
  const { store, uid } = ctx, now = ctx.now || new Date();
  args = args && typeof args === "object" ? args : {};
  const prof = await profileOf(store, uid), clock = clockIn(prof.timezone, now), today = clock.date;

  if (name === "get_schedule") {
    const start = args.start_date ?? today;
    if (!isDate(start)) fail("start_date must be YYYY-MM-DD.");
    const n = args.days ?? 7;
    if (!Number.isInteger(n) || n < 1 || n > 31) fail("days must be a whole number from 1 to 31.");
    const end = addDays(start, n - 1);
    const [range, someday, left] = await Promise.all([store.listRange(uid, start, end), store.listSomeday(uid), store.listOverdue(uid, today, addDays(today, -30))]);
    const span = toMin(prof.day_end) - toMin(prof.day_start);
    const days = [];
    for (let i = 0; i < n; i++) {
      const d = addDays(start, i), all = range.filter(t => t.day === d);
      const showDone = args.include_done ?? d === today;
      const list = all.filter(t => showDone || !t.done).sort((a, b) => (a.start_time ? toMin(a.start_time) : 9999) - (b.start_time ? toMin(b.start_time) : 9999));
      const timed = all.filter(t => t.start_time && !t.done).reduce((a, t) => a + t.duration_min, 0);
      days.push({ date: d, weekday: weekday(d), ...(d === today ? { is_today: true } : {}), tasks: list.map(out), planned_min: all.reduce((a, t) => a + t.duration_min, 0), free_min_in_day: Math.max(0, span - timed) });
    }
    return {
      today, weekday: weekday(today), now: clock.time, timezone: prof.timezone,
      preferences: { day_start: prof.day_start, day_end: prof.day_end, focus_hours: prof.focus_hours || null, notes: prof.notes || null },
      days,
      left_over_from_earlier_days: left.map(out),
      someday: someday.map(out),
    };
  }

  if (name === "add_tasks") {
    const items = Array.isArray(args.tasks) ? args.tasks : fail("tasks must be a list.");
    if (!items.length || items.length > 25) fail("Add between 1 and 25 tasks at a time.");
    const rows = items.map((it, i) => {
      if (!it || typeof it !== "object") fail(`tasks[${i}] must be an object.`);
      const r = { duration_min: 30, kind: "flexible", priority: 2, notes: "", due: null, start_time: null, ...toRow(it, false, `tasks[${i}]`) };
      if (r.day == null) r.start_time = null;
      delete r.done; delete r.done_at;
      checkFits(r, `tasks[${i}]`);
      return r;
    });
    const added = [], warnings = [];
    for (const r of rows) {
      const t = await store.insertTask(uid, r);
      added.push(t);
      await store.logChange(uid, { task_id: t.id, action: "add", before: null, after: t,
        summary: `Added “${t.title}” ${whenWords(t, today)}${t.day ? ` (${durLabel(t.duration_min)})` : ""}` });
    }
    const days = [...new Set(added.filter(t => t.day).map(t => t.day))];
    const existing = days.length ? (await store.listRange(uid, days.reduce((a, b) => a < b ? a : b), days.reduce((a, b) => a > b ? a : b))) : [];
    for (const t of added) warnings.push(...overlaps(t, existing));
    return { added: added.map(out), ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}) };
  }

  if (name === "update_tasks") {
    const items = Array.isArray(args.updates) ? args.updates : fail("updates must be a list.");
    if (!items.length || items.length > 25) fail("Change between 1 and 25 tasks at a time.");
    const plans = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      if (!UUID.test(String(it.id || ""))) fail(`updates[${i}]: id "${it.id}" isn't a task id. Use the ids from get_schedule.`);
      const { id, ...rest } = it;
      if (!Object.keys(rest).length) fail(`updates[${i}]: nothing to change.`);
      const before = await store.getTask(uid, id);
      if (!before) fail(`updates[${i}]: no task with id ${id}. It may have been deleted; call get_schedule again.`);
      const row = toRow(rest, true, `updates[${i}]`);
      const merged = { ...before, ...row };
      if (merged.day == null) { merged.start_time = null; row.start_time = null; }
      checkFits(merged, `updates[${i}]`);
      plans.push({ id, before, row });
    }
    const updated = [], warnings = [];
    for (const p of plans) {
      const after = await store.updateTask(uid, p.id, p.row);
      updated.push(after);
      await store.logChange(uid, { task_id: p.id, action: "update", before: p.before, after, summary: describeUpdate(p.before, after, today) });
    }
    const days = [...new Set(updated.filter(t => t.day).map(t => t.day))];
    const existing = days.length ? (await store.listRange(uid, days.reduce((a, b) => a < b ? a : b), days.reduce((a, b) => a > b ? a : b))) : [];
    for (const t of updated) warnings.push(...overlaps(t, existing));
    return { updated: updated.map(out), ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}) };
  }

  if (name === "delete_tasks") {
    const ids = Array.isArray(args.ids) ? args.ids : fail("ids must be a list.");
    if (!ids.length || ids.length > 25) fail("Remove between 1 and 25 tasks at a time.");
    const removed = [], missing = [];
    for (const id of ids) {
      const before = UUID.test(String(id)) ? await store.getTask(uid, id) : null;
      if (!before) { missing.push(String(id)); continue; }
      await store.deleteTask(uid, id);
      await store.logChange(uid, { task_id: id, action: "delete", before, after: null, summary: `Removed “${before.title}” (was ${whenWords(before, today)})` });
      removed.push({ id, title: before.title });
    }
    return { removed, ...(missing.length ? { not_found: missing } : {}) };
  }

  if (name === "set_preferences") {
    const patch = {};
    for (const k of ["day_start", "day_end"]) if (args[k] !== undefined) { const t = normTime(args[k]); if (!t) fail(`${k} must be HH:MM (24-hour).`); patch[k] = t; }
    if (args.focus_hours !== undefined) { if (typeof args.focus_hours !== "string" || args.focus_hours.length > 200) fail("focus_hours must be text up to 200 characters."); patch.focus_hours = args.focus_hours.trim(); }
    if (args.notes !== undefined) { if (typeof args.notes !== "string" || args.notes.length > 2000) fail("notes must be text up to 2000 characters."); patch.notes = args.notes.trim(); }
    if (args.timezone !== undefined) { if (typeof args.timezone !== "string" || !validTz(args.timezone)) fail("timezone must be an IANA name like America/Los_Angeles."); patch.timezone = args.timezone; }
    if (!Object.keys(patch).length) fail("Nothing to change.");
    const next = { ...prof, ...patch };
    if (toMin(next.day_end) <= toMin(next.day_start)) fail("day_end must be after day_start.");
    const saved = await store.upsertProfile(uid, { timezone: next.timezone, day_start: next.day_start, day_end: next.day_end, focus_hours: next.focus_hours, notes: next.notes });
    return { preferences: { timezone: saved.timezone, day_start: hm(saved.day_start), day_end: hm(saved.day_end), focus_hours: saved.focus_hours || null, notes: saved.notes || null } };
  }

  fail(`Unknown tool: ${name}`);
}

// One JSON-RPC message in, one response out (null for notifications).
async function handleRpc(msg, ctx) {
  const isReq = msg && typeof msg === "object" && msg.jsonrpc === "2.0" && typeof msg.method === "string";
  const id = msg && Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : undefined;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const error = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!isReq) return error(-32600, "Invalid request");
  if (id === undefined) return null; // notification (e.g. notifications/initialized)
  const p = msg.params || {};
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      if (!TOOLS.some(t => t.name === p.name)) return error(-32602, `Unknown tool: ${p.name}`);
      try {
        const data = await callTool(p.name, p.arguments, ctx);
        return reply({ content: [{ type: "text", text: JSON.stringify(data) }] });
      } catch (e) {
        if (e instanceof ToolError) return reply({ content: [{ type: "text", text: e.message }], isError: true });
        console.error(e);
        return reply({ content: [{ type: "text", text: "The planner database had a problem. Try again in a moment." }], isError: true });
      }
    }
    case "resources/list": return reply({ resources: [] });
    case "prompts/list": return reply({ prompts: [] });
    default:
      return error(-32601, `Method not found: ${msg.method}`);
  }
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// HTTP layer for MCP's Streamable HTTP transport (stateless: plain JSON replies, no SSE).
async function handleHttp(req, store) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, mcp-protocol-version, mcp-session-id", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("This connector only accepts MCP POST requests.", { status: 405, headers: { ...cors, Allow: "POST, OPTIONS" } });
  const token = new URL(req.url).pathname.split("/").filter(Boolean).pop() || "";
  const uid = token.length >= 20 && token !== "plan-mcp" ? await store.userForTokenHash(await sha256Hex(token)) : null;
  if (!uid) return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "This connector link isn't valid. Make a new one in the Plan app's Claude tab." } }, 401);
  let body;
  try { body = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  const ctx = { store, uid };
  if (Array.isArray(body)) {
    const res = (await Promise.all(body.map(m => handleRpc(m, ctx)))).filter(Boolean);
    return res.length ? json(res) : new Response(null, { status: 202, headers: cors });
  }
  const res = await handleRpc(body, ctx);
  return res ? json(res) : new Response(null, { status: 202, headers: cors });
}
// ==== CORE END ====

// Supabase-backed store. The service-role key bypasses row rules, so every query is scoped to the link's user.
const COLS = "id,title,notes,day,start_time,duration_min,kind,priority,due,done,done_at,source,created_at,updated_at";
// Prefer the project's new secret key (SUPABASE_SECRET_KEYS); fall back to the legacy service-role key.
function serverKey() {
  try { const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); const k = keys.default || Object.values(keys)[0]; if (k) return k; } catch { /* use the legacy key */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}
const db = createClient(Deno.env.get("SUPABASE_URL"), serverKey(), { auth: { persistSession: false } });
const must = (r) => { if (r.error) throw r.error; return r.data; };
const store = {
  async userForTokenHash(hash) { return must(await db.from("plan_connector").select("user_id").eq("token_hash", hash).maybeSingle())?.user_id || null; },
  async getProfile(uid) { return must(await db.from("plan_profile").select("*").eq("user_id", uid).maybeSingle()); },
  async upsertProfile(uid, p) { return must(await db.from("plan_profile").upsert({ user_id: uid, ...p }).select("*").single()); },
  async listRange(uid, from, to) { return must(await db.from("plan_tasks").select(COLS).eq("user_id", uid).gte("day", from).lte("day", to).order("day").order("start_time")); },
  async listSomeday(uid) { return must(await db.from("plan_tasks").select(COLS).eq("user_id", uid).is("day", null).eq("done", false).order("created_at")); },
  async listOverdue(uid, before, since) { return must(await db.from("plan_tasks").select(COLS).eq("user_id", uid).lt("day", before).gte("day", since).eq("done", false).order("day")); },
  async getTask(uid, id) { return must(await db.from("plan_tasks").select(COLS).eq("user_id", uid).eq("id", id).maybeSingle()); },
  async insertTask(uid, row) { return must(await db.from("plan_tasks").insert({ ...row, user_id: uid, source: "claude" }).select(COLS).single()); },
  async updateTask(uid, id, row) { return must(await db.from("plan_tasks").update(row).eq("user_id", uid).eq("id", id).select(COLS).single()); },
  async deleteTask(uid, id) { must(await db.from("plan_tasks").delete().eq("user_id", uid).eq("id", id)); },
  async logChange(uid, c) { must(await db.from("plan_changes").insert({ user_id: uid, ...c })); },
};

// One log line per request (never the secret link) to help diagnose connection problems.
Deno.serve(async (req) => {
  let body = "";
  try { body = await req.clone().text(); } catch { /* no body */ }
  let rpc = null;
  try { const j = JSON.parse(body); rpc = (Array.isArray(j) ? j : [j]).map(x => [x.method, x.params?.protocolVersion, x.params?.clientInfo?.name].filter(Boolean).join(" ")); } catch { /* not JSON */ }
  const res = await handleHttp(req, store);
  console.log(JSON.stringify({ http: req.method, status: res.status, rpc, accept: req.headers.get("accept"), protocol: req.headers.get("mcp-protocol-version"), session: req.headers.get("mcp-session-id"), auth: req.headers.has("authorization"), ua: req.headers.get("user-agent") }));
  return res;
});
