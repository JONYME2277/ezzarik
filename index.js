// Test boti (Node.js) — 5 ta fan, har birida 100 ta savol. Tashqi paket kerak emas.
const fs = require("fs");
const path = require("path");
const http = require("http");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error("BOT_TOKEN topilmadi"); process.exit(1); }
const ADMIN_ID = Number(process.env.ADMIN_ID || "7705007100");
const SUBJECTS = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf8"));
const RESULTS_FILE = path.join(__dirname, "results.csv");
const API = `https://api.telegram.org/bot${TOKEN}`;

const SESSIONS = new Map(); // userId -> sessiya
const POLLS = new Map();    // pollId -> {uid, chatId, correct, qi}

async function api(method, params = {}) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function start(chatId) {
  const kb = SUBJECTS.map((f, i) => [{ text: f.name, callback_data: `s${i}` }]);
  await api("sendMessage", { chat_id: chatId, text: "Fanni tanlang:", reply_markup: { inline_keyboard: kb } });
}

async function chooseSubject(cq) {
  await api("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
  const si = Number(cq.data.slice(1));
  const total = SUBJECTS[si].qs.length;
  const kb = [
    [{ text: "20 ta savol", callback_data: `n${si}_20` }],
    [{ text: "40 ta savol", callback_data: `n${si}_40` }],
    [{ text: `Hammasi (${total} ta)`, callback_data: `n${si}_${total}` }],
  ];
  await api("sendMessage", {
    chat_id: cq.message.chat.id,
    text: `${SUBJECTS[si].name}\nNechta savol ishlaymiz?`,
    reply_markup: { inline_keyboard: kb },
  });
}

async function chooseCount(cq) {
  await api("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
  const [si, n] = cq.data.slice(1).split("_").map(Number);
  const qs = SUBJECTS[si].qs;
  const idx = shuffle([...qs.keys()]).slice(0, Math.min(n, qs.length));
  const u = cq.from;
  SESSIONS.set(u.id, {
    s: si, items: idx, k: 0, ok: 0, bad: [],
    name: [u.first_name, u.last_name].filter(Boolean).join(" "),
    username: u.username || "-",
  });
  await sendNext(cq.message.chat.id, u.id);
}

async function sendNext(chatId, uid) {
  const s = SESSIONS.get(uid);
  if (!s) return;
  if (s.k >= s.items.length) return finish(chatId, uid);
  const q = SUBJECTS[s.s].qs[s.items[s.k]];
  const right = q[1];
  const opts = shuffle(q.slice(1));
  const correct = opts.indexOf(right);
  const msg = await api("sendPoll", {
    chat_id: chatId,
    question: `${s.k + 1}/${s.items.length}. ${q[0]}`.slice(0, 300),
    options: opts.map((o) => o.slice(0, 100)),
    type: "quiz",
    correct_option_id: correct,
    is_anonymous: false,
  });
  POLLS.set(msg.poll.id, { uid, chatId, correct, qi: s.items[s.k] });
}

async function onPollAnswer(pa) {
  const info = POLLS.get(pa.poll_id);
  if (!info) return;
  POLLS.delete(pa.poll_id);
  const s = SESSIONS.get(info.uid);
  if (!s) return;
  if (pa.option_ids.length && pa.option_ids[0] === info.correct) s.ok++;
  else s.bad.push(info.qi);
  s.k++;
  await sendNext(info.chatId, info.uid);
}

async function finish(chatId, uid) {
  const s = SESSIONS.get(uid);
  SESSIONS.delete(uid);
  const qs = SUBJECTS[s.s].qs;
  const n = s.items.length;
  let text = `${SUBJECTS[s.s].name}\nNatija: ${s.ok} / ${n} (${Math.round((s.ok / n) * 100)}%)`;
  if (s.bad.length) {
    text += "\n\nXato javoblar:\n" + s.bad.map((i) => `• ${qs[i][0]}\n  To‘g‘ri: ${qs[i][1]}`).join("\n");
  }
  for (let i = 0; i < text.length; i += 4000) {
    await api("sendMessage", { chat_id: chatId, text: text.slice(i, i + 4000) });
  }
  await report(uid, s, n);
  await api("sendMessage", { chat_id: chatId, text: "Boshqa fan uchun /start bosing." });
}

async function report(uid, s, n) {
  try {
    const d = new Date(Date.now() + 5 * 3600 * 1000); // UTC+5
    const when = d.toISOString().slice(0, 16).replace("T", " ");
    const subj = SUBJECTS[s.s].name;
    const pct = Math.round((s.ok / n) * 100);
    const isNew = !fs.existsSync(RESULTS_FILE);
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    let row = [when, s.name, s.username, uid, subj, s.ok, n, pct].map(esc).join(",") + "\n";
    if (isNew) row = "\uFEFF" + ["Vaqt", "Ism", "Username", "ID", "Fan", "To'g'ri", "Jami", "Foiz"].map(esc).join(",") + "\n" + row;
    fs.appendFileSync(RESULTS_FILE, row, "utf8");
    await api("sendMessage", {
      chat_id: ADMIN_ID,
      text: `${s.name} (@${s.username})\n${subj}\nBall: ${s.ok}/${n} (${pct}%)\n${when}`,
    });
  } catch (e) {
    console.warn("Natijani yuborib bo'lmadi:", e.message);
  }
}

async function sendResults(chatId) {
  if (!fs.existsSync(RESULTS_FILE)) {
    return api("sendMessage", { chat_id: chatId, text: "Hali natija yo‘q." });
  }
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([fs.readFileSync(RESULTS_FILE)]), "natijalar.csv");
  const r = await fetch(`${API}/sendDocument`, { method: "POST", body: form });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description);
}

async function handle(u) {
  if (u.message && u.message.text) {
    const t = u.message.text.trim();
    if (t.startsWith("/start")) await start(u.message.chat.id);
    else if (t.startsWith("/natijalar") && u.message.from.id === ADMIN_ID) await sendResults(u.message.chat.id);
  } else if (u.callback_query) {
    const d = u.callback_query.data || "";
    if (/^s\d+$/.test(d)) await chooseSubject(u.callback_query);
    else if (/^n\d+_\d+$/.test(d)) await chooseCount(u.callback_query);
  } else if (u.poll_answer) {
    await onPollAnswer(u.poll_answer);
  }
}

// Hosting "port javob beradimi" deb tekshirishi mumkin
http.createServer((_, res) => res.end("ok")).listen(Number(process.env.PORT || 4019), "0.0.0.0");

async function main() {
  await api("deleteWebhook").catch(() => {});
  console.log("Bot ishga tushdi");
  let offset = 0;
  for (;;) {
    try {
      const ups = await api("getUpdates", {
        offset, timeout: 30,
        allowed_updates: ["message", "callback_query", "poll_answer"],
      });
      for (const u of ups) {
        offset = u.update_id + 1;
        handle(u).catch((e) => console.error("Xato:", e.message));
      }
    } catch (e) {
      console.error("Polling xatosi:", e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
main();
