// الكرة الحيّة في الأعلى: نحمّلها فقط إذا الجهاز يدعم WebGL وما طلب المستخدم تقليل الحركة أو البيانات
(function () {
  const f = document.getElementById('globe');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const saveData = navigator.connection && navigator.connection.saveData;
  let gl = false;
  try { gl = !!document.createElement('canvas').getContext('webgl2'); } catch (e) {}
  if (!gl || reduce || saveData) { f.remove(); return; }
  f.addEventListener('load', () => setTimeout(() => f.classList.add('ready'), 2600));
  f.src = 'app/?embed';
  // نوقف رسم الكرة لما تنزل تحت عشان الصفحة تظل سلسة
  new IntersectionObserver(([e]) => {
    try { f.contentWindow.postMessage(e.isIntersecting ? 'resume' : 'pause', '*'); } catch (err) {}
  }, { threshold: 0.05 }).observe(f);
})();

// نسخ بيانات التحويل
(function () {
  const toast = document.getElementById('toast');
  let t;
  const show = (m) => { toast.textContent = m; toast.classList.add('on'); clearTimeout(t); t = setTimeout(() => toast.classList.remove('on'), 1800); };
  document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.v); show('تم النسخ'); }
    catch (e) { show('انسخه يدوي بالضغط المطوّل'); }
  }));
})();

// عدّاد الزيارات والتحميلات (GoatCounter، بدون كوكيز)
(function () {
  const base = 'https://miqatapp.goatcounter.com/counter/';
  const get = (p) => fetch(base + encodeURIComponent(p) + '.json').then((r) => r.ok ? r.json() : null).catch(() => null);
  const num = (r) => r ? parseInt(String(r.count).replace(/\D/g, ''), 10) || 0 : 0;
  const MIN = 100; // ما نعرض الرقم إلا إذا تعدّى 100
  Promise.all([get('download-apk'), get('TOTAL')]).then(([d, v]) => {
    const dl = num(d), vis = num(v);
    const sDl = document.getElementById('sDl'), sVis = document.getElementById('sVis');
    sDl.textContent = dl.toLocaleString('en'); sVis.textContent = vis.toLocaleString('en');
    sDl.parentElement.hidden = dl <= MIN; sVis.parentElement.hidden = vis <= MIN;
    if (dl > MIN || vis > MIN) document.getElementById('stats').hidden = false;
  });
})();
