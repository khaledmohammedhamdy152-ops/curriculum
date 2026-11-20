const $ = s => document.querySelector(s);
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ---------- التخزين (IndexedDB) ---------- */
let _db;
function db() {
  if (_db) return _db;
  _db = new Promise((res, rej) => {
    const r = indexedDB.open('curriculum-db', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('books', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return _db;
}
async function dbAll() {
  const d = await db();
  return new Promise(res => { const q = d.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); });
}
async function dbPut(b) {
  const d = await db();
  return new Promise(res => { const t = d.transaction('books', 'readwrite'); t.objectStore('books').put(b); t.oncomplete = res; });
}
async function dbDel(id) {
  const d = await db();
  return new Promise(res => { const t = d.transaction('books', 'readwrite'); t.objectStore('books').delete(id); t.oncomplete = res; });
}

/* ---------- معالجة النص العربي ---------- */
const STOP = new Set(('من في على الى عن ما هو هي هل ماذا لماذا كيف متى اين هذا هذه ذلك تلك التي الذي الذين و او ان اذا كان يكون مع ثم لا به بها له لها كل اذكر اشرح عرف وضح ماهو ماهي ماهى تعريف عدد بين هناك قد لم لن ايضا انه انها بعد قبل خلال حتي حتى').split(' '));

function norm(t) {
  return t.toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
}
function stem(w) {
  w = w.replace(/^(وال|بال|كال|فال|لل|ال)/, '');
  if (w.length > 5) w = w.replace(/(ات|ون|ين|ان)$/, '');
  return w;
}
function tokens(t, keepStop) {
  const out = [];
  for (const w of norm(t).split(/\s+/)) {
    if (!w) continue;
    if (!keepStop && (STOP.has(w) || (w.length < 2 && !/\d/.test(w)))) continue;
    out.push(stem(w));
  }
  return out;
}

/* ---------- الفهرس في الذاكرة ---------- */
let CH = [], DF = new Map(), AVG = 1;
async function buildIndex() {
  const books = await dbAll();
  CH = []; DF = new Map();
  for (const b of books) for (const c of b.chunks) {
    const tk = tokens(c.t, true), tf = new Map();
    for (const w of tk) tf.set(w, (tf.get(w) || 0) + 1);
    for (const w of tf.keys()) DF.set(w, (DF.get(w) || 0) + 1);
    CH.push({ book: b.name, page: c.p, text: c.t, tf, len: tk.length || 1, n: norm(c.t) });
  }
  AVG = CH.reduce((a, c) => a + c.len, 0) / (CH.length || 1);
  return books;
}
function search(q, k = 3) {
  const qt = [...new Set(tokens(q))];
  if (!qt.length || !CH.length) return { res: [], qt };
  const N = CH.length, k1 = 1.4, b = 0.75;
  const nq = norm(q).replace(/\s+/g, ' ').trim();
  const scored = CH.map(c => {
    let s = 0;
    for (const w of qt) {
      const f = c.tf.get(w); if (!f) continue;
      const df = DF.get(w);
      s += Math.log(1 + (N - df + 0.5) / (df + 0.5)) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * c.len / AVG));
    }
    if (s > 0 && qt.length > 1 && c.n.includes(nq)) s *= 1.5;
    return { c, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  // تجنّب تكرار نفس الصفحة
  const out = [], seen = new Set();
  for (const x of scored) {
    const key = x.c.book + x.c.page;
    if (seen.has(key)) continue;
    seen.add(key); out.push(x.c);
    if (out.length >= k) break;
  }
  return { res: out, qt };
}

/* ---------- إضافة كتاب ---------- */
function chunkPage(text, page) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const chunks = []; let cur = '';
  for (const l of lines) {
    if (cur && (cur + ' ' + l).length > 600) { chunks.push({ p: page, t: cur }); cur = l; }
    else cur = cur ? cur + '\n' + l : l;
  }
  if (cur.length > 20) chunks.push({ p: page, t: cur });
  return chunks;
}
async function addBook(file) {
  $('#progress').classList.remove('hidden');
  $('#pname').textContent = file.name;
  const buf = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const chunks = [];
  let chars = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let s = '';
    for (const it of tc.items) s += it.str + (it.hasEOL ? '\n' : ' ');
    chars += s.length;
    chunks.push(...chunkPage(s, i));
    page.cleanup();
    $('#fill').style.width = (i / pdf.numPages * 100) + '%';
    $('#ptext').textContent = `الصفحة ${i} من ${pdf.numPages}`;
    if (i % 5 === 0) await new Promise(r => setTimeout(r));
  }
  if (chars < pdf.numPages * 30) {
    alert('هذا الملف لا يحتوي على نص قابل للنسخ (غالبًا صور ممسوحة). يحتاج قراءة OCR.');
    $('#progress').classList.add('hidden');
    return;
  }
  await dbPut({ id: Date.now().toString(), name: file.name.replace(/\.pdf$/i, ''), pages: pdf.numPages, chunks });
  $('#progress').classList.add('hidden');
  await renderBooks();
}
async function renderBooks() {
  const books = await buildIndex();
  const ul = $('#books'); ul.innerHTML = '';
  if (!books.length) ul.innerHTML = '<li class="hint">لا توجد كتب بعد.</li>';
  for (const b of books) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="nm"></div><button>حذف</button>';
    li.querySelector('.nm').innerHTML = '📘 ' + esc(b.name) + `<small>${b.pages} صفحة</small>`;
    li.querySelector('button').onclick = async () => {
      if (confirm('حذف هذا الكتاب؟')) { await dbDel(b.id); renderBooks(); }
    };
    ul.appendChild(li);
  }
}

/* ---------- الواجهة ---------- */
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function highlight(text, qt) {
  const set = new Set(qt);
  return text.split(/(\s+)/).map(w => {
    if (!w.trim()) return esc(w);
    const st = stem(norm(w).trim());
    return set.has(st) && st ? `<mark>${esc(w)}</mark>` : esc(w);
  }).join('');
}
function bubble(cls, html) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls; d.innerHTML = html;
  $('#msgs').appendChild(d);
  $('#msgs').scrollTop = $('#msgs').scrollHeight;
}
function ask(q) {
  bubble('me', `<div class="txt">${esc(q)}</div>`);
  if (!CH.length) {
    bubble('bot', 'لا توجد كتب في قاعدة البيانات. افتح ⚙️ الإعدادات وأضف كتابًا أولًا.');
    return;
  }
  const { res, qt } = search(q);
  if (!res.length) {
    bubble('bot', 'لم أجد إجابة في الكتب. جرّب كلمات مختلفة أو أقل.');
    return;
  }
  const html = res.map(c =>
    `<div class="src">📖 ${esc(c.book)} — صفحة ${c.page}</div><div class="txt">${highlight(c.text, qt)}</div>`
  ).join('<hr class="sep">');
  bubble('bot', html);
}
const qEl = $('#q');
qEl.addEventListener('input', () => { qEl.style.height = 'auto'; qEl.style.height = qEl.scrollHeight + 'px'; });
$('#form').addEventListener('submit', e => {
  e.preventDefault();
  const q = qEl.value.trim(); if (!q) return;
  qEl.value = ''; qEl.style.height = 'auto';
  ask(q);
});
$('#openSettings').onclick = () => { $('#chat').classList.add('hidden'); $('#settings').classList.remove('hidden'); };
$('#back').onclick = () => { $('#settings').classList.add('hidden'); $('#chat').classList.remove('hidden'); };
$('#file').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { await addBook(f); } catch (err) { alert('تعذّرت قراءة الملف: ' + err.message); $('#progress').classList.add('hidden'); }
});

(async () => {
  await renderBooks();
  bubble('bot', CH.length ? 'اسألني أي سؤال وسأجيبك من نص الكتاب مباشرة.' : 'أهلًا! افتح ⚙️ الإعدادات ← قاعدة البيانات وأضف أول كتاب، ثم عد واسأل.');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
})();
