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

