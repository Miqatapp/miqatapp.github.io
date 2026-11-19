export const STR = {
  ar: {
    title: 'Quest AI',
    micOn: 'أسمعك', micOff: 'المايك مطفأ', alwaysListen: 'المايك شغّال دائماً (بدون ضغط)', autoCam: 'شغّل الكاميرا تلقائياً عند الفتح',
    modelSwitched: 'الموديل القديم انتهى — حوّلت تلقائياً إلى {m}',
    errKey: 'المفتاح غير صحيح أو ما له صلاحية. راجعه في الإعدادات.', errQuota: 'وصلت حد الاستخدام عند المزوّد. انتظر شوي أو غيّر المزوّد.',
    errModel: 'الموديل غير متاح. اختر موديل ثاني من الإعدادات.', errNet: 'ما فيه اتصال بالإنترنت.',
    settings: 'الإعدادات', done: 'تم',
    provider: 'المزوّد', model: 'الموديل', fetchModels: 'تجربة المفتاح وجلب الموديلات',
    keys: 'مفاتيح API', keyHint: 'المفاتيح تنحفظ في هذا الجهاز فقط وما تُرسل إلا للمزوّد نفسه.',
    customBase: 'رابط API (متوافق مع OpenAI)', customKey: 'مفتاح API', customPreset: 'مزوّد آخر',
    system: 'شخصية المساعد', systemPh: 'اتركه فاضي للافتراضي',
    voice: 'الصوت', ttsOn: 'يرد عليّ بصوت', ttsEngine: 'محرك النطق', ttsVoice: 'صوت OpenAI',
    sttEngine: 'تحويل الكلام لنص', auto: 'تلقائي', browser: 'صوت الجهاز',
    vadSens: 'حساسية الاستماع', low: 'منخفضة', medium: 'متوسطة', high: 'عالية',
    camera: 'الكاميرا', camDevice: 'الكاميرا المستخدمة', camAttach: 'يشوف الكاميرا مع كل سؤال',
    language: 'اللغة', about: 'حول',
    talk: 'اضغط وتكلّم', live: 'مباشر', liveOn: 'مباشر', look: 'وش هذا؟', stop: 'إيقاف', cam: 'كاميرا', screen: 'الشاشة', clear: 'مسح المحادثة',
    camOff: 'الكاميرا مطفأة', camOffSub: 'شغّلها عشان يشوف اللي قدامك', camEnable: 'شغّل الكاميرا',
    whatsThisQ: 'وش تشوف قدامي؟ اشرح باختصار.',
    typePh: 'اكتب سؤالك…', conversation: 'المحادثة',
    emptyTitle: 'جاهز', emptyBody: 'تكلّم براحتك — أسمعك وأشوف الكاميرا. جرّب: «وين القارورة؟»',
    st_idle: 'جاهز', st_listening: 'أسمعك', st_hearing: 'أسمع…', st_thinking: 'أفكر…', st_speaking: 'أتكلم…', st_looking: 'أحلّل الصورة…',
    transcribing: 'أحوّل كلامك لنص…', tooShort: 'التسجيل قصير', heardNothing: 'ما سمعت شي واضح',
    needKey: 'حط مفتاح {p} في الإعدادات', needSttKey: 'الكلام بالصوت يحتاج مفتاح OpenAI أو Gemini',
    noKeys: 'حط مفتاح API واحد على الأقل عشان تبدأ', openSettings: 'افتح الإعدادات',
    permMic: 'المايك مقفول — التطبيق يحتاج إذن عشان يسمعك.', permCam: 'الكاميرا مقفولة — التطبيق يحتاج إذن عشان يشوف.',
    permAllow: 'اسمح', permSettings: 'إعدادات التطبيق',
    noCam: 'ما قدرت أفتح الكاميرا: {e}', error: 'خطأ', stopped: 'تم الإيقاف',
    modelsLoaded: 'المفتاح شغّال ✓ — {n} موديل', found: 'حدّدت {n}',
    enterVR: 'VR', enterAR: 'Passthrough',
    hints: 'A/X مطوّل: تكلّم · B/Y: وش هذا؟ · الزر الجانبي على اللوحة: حرّكها · ضغط العصا: توسيط',
    recenter: 'توسيط', exit: 'خروج',
    sysDefault: 'أنت Quest AI، مساعد ذكي داخل نظارة Meta Quest. ردّ بلغة المستخدم ولهجته، بإيجاز وبأسلوب محادثة طبيعي لأن ردك يُقرأ بصوت. لا تستخدم Markdown ولا قوائم. إذا وصلتك صورة فهي من كاميرا النظارة وتمثّل اللي يشوفه المستخدم الحين.',
  },
  en: {
    title: 'Quest AI',
    micOn: 'Listening', micOff: 'Mic off', alwaysListen: 'Mic always on (no button needed)', autoCam: 'Turn on camera when the app opens',
    modelSwitched: 'Old model retired — switched to {m}',
    errKey: 'The API key is invalid or not allowed. Check it in Settings.', errQuota: 'Usage limit reached at the provider. Wait a bit or switch provider.',
    errModel: 'Model not available. Pick another model in Settings.', errNet: 'No internet connection.',
    settings: 'Settings', done: 'Done',
    provider: 'Provider', model: 'Model', fetchModels: 'Test key & fetch models',
    keys: 'API keys', keyHint: 'Keys are stored only on this device and sent only to their provider.',
    customBase: 'API URL (OpenAI-compatible)', customKey: 'API key', customPreset: 'Other provider',
    system: 'Assistant personality', systemPh: 'Leave empty for the default',
    voice: 'Voice', ttsOn: 'Reply with voice', ttsEngine: 'Speech engine', ttsVoice: 'OpenAI voice',
    sttEngine: 'Speech to text', auto: 'Auto', browser: 'Device voice',
    vadSens: 'Listening sensitivity', low: 'Low', medium: 'Medium', high: 'High',
    camera: 'Camera', camDevice: 'Camera device', camAttach: 'Sees the camera with every question',
    language: 'Language', about: 'About',
    talk: 'Hold to talk', live: 'Live', liveOn: 'Live', look: "What's this?", stop: 'Stop', cam: 'Camera', screen: 'Screen', clear: 'Clear chat',
    camOff: 'Camera is off', camOffSub: 'Turn it on so it can see what you see', camEnable: 'Turn on camera',
    whatsThisQ: 'What do you see in front of me? Explain briefly.',
    typePh: 'Ask anything…', conversation: 'Conversation',
    emptyTitle: 'Ready', emptyBody: 'Just talk — I hear you and see the camera. Try: “Where is the bottle?”',
    st_idle: 'Ready', st_listening: 'Listening', st_hearing: 'Hearing…', st_thinking: 'Thinking…', st_speaking: 'Speaking…', st_looking: 'Analyzing frame…',
    transcribing: 'Transcribing…', tooShort: 'Recording too short', heardNothing: "Didn't catch that",
    needKey: 'Add your {p} key in Settings', needSttKey: 'Voice needs an OpenAI or Gemini key',
    noKeys: 'Add at least one API key to start', openSettings: 'Open Settings',
    permMic: 'Microphone is blocked — the app needs permission to hear you.', permCam: 'Camera is blocked — the app needs permission to see.',
    permAllow: 'Allow', permSettings: 'App settings',
    noCam: "Couldn't open the camera: {e}", error: 'Error', stopped: 'Stopped',
    modelsLoaded: 'Key works ✓ — {n} models', found: 'Found {n}',
    enterVR: 'VR', enterAR: 'Passthrough',
    hints: 'Hold A/X: talk · B/Y: what is this? · Grip on panel: move it · Stick click: recenter',
    recenter: 'Recenter', exit: 'Exit',
    sysDefault: "You are Quest AI, an assistant inside a Meta Quest headset. Reply in the user's language and dialect, briefly and conversationally, because your reply is read aloud. No Markdown, no lists. If you receive an image, it comes from the headset camera and shows what the user is looking at right now.",
  },
};

// Appended to every request that carries an image. Gemini is trained on exactly this box format.
export const BOX_INSTRUCTIONS = `
When an image is attached and the user asks you to find, locate, point at, show, count or identify specific things in it (or when marking objects clearly helps your answer), append at the very end of your reply one tag in this exact format and nothing after it:
<boxes>[{"label":"<short name in the user's language>","box":[ymin,xmin,ymax,xmax]}]</boxes>
Coordinates are integers normalized to 0-1000 relative to the image. Never mention the tag or the coordinates in your spoken text.`;

export function t(lang, k, vars) {
  let s = (STR[lang] && STR[lang][k]) ?? STR.en[k] ?? k;
  if (vars) for (const [a, b] of Object.entries(vars)) s = s.replace('{' + a + '}', b);
  return s;
}
