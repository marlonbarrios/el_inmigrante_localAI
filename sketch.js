import './style.css';

// Local Qwen through Ollama. Vite proxies /ollama/* to http://127.0.0.1:11434.
const REQUESTED_MODEL = (import.meta.env.VITE_OLLAMA_MODEL || 'qwen3.5:27b').trim();
const OLLAMA_CHAT_URL = '/ollama/api/chat';
const OLLAMA_TAGS_URL = '/ollama/api/tags';

let ollamaReady = false;
let resolvedModel = REQUESTED_MODEL;
let generationInFlight = false;

const SYSTEM_PROMPT = `You write exactly two spoken lines.
Each line starts with an em dash (—) and has 2 to 4 words.
Write in the language of the user message. Nothing else.

The subject is longing. The person wants to forget and also keeps remembering. That contradiction makes the missing worse.
The seed is "Forget something?" / "If only." Do not copy it.

Use plain, exact, grammatical words, the way a person would speak.
Do not invent strange phrases. Do not pile up nouns.
Do not decorate with soul, dust, echo, silence, shine, or emptiness.
In Spanish, never end a line with "ya".
Change the concrete thing. Stay inside the longing.`;

const GENERATION_COUNT_KEY = 'elinmigrante-generation-count';
const RECENT_LINES_KEY = 'elinmigrante-recent-lines';
const MAX_RECENT_LINES = 24;

// Plain objects inside the same longing. Kept simple so the model does not translate them into strange phrases.
const PARADOX_TURNS = [
  'a name',
  'the house',
  'a face',
  'a date',
  'the mother tongue',
  'a person who is not here',
  'the road home',
  'papers',
  'the old kitchen',
  'a voice on the phone',
  'money sent home',
  'the city left behind',
  'a promise',
  'a mother or a child',
  'the border',
  'a song from home',
  'a key',
  'the country left behind'
];

function readStoredCount() {
  const count = Number(localStorage.getItem(GENERATION_COUNT_KEY));
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function readRecentLines() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_LINES_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((line) => typeof line === 'string').slice(-MAX_RECENT_LINES);
  } catch {
    return [];
  }
}

let generationCount = readStoredCount();
let recentLines = readRecentLines();

function lineWords(line) {
  return line
    .toLowerCase()
    .replace(/^[—–\-•]\s*/, '')
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
}

function wordsToAvoid(lines) {
  const counts = new Map();
  const endings = new Map();
  for (const line of lines) {
    const words = lineWords(line);
    for (const word of new Set(words.filter((word) => word.length > 4))) {
      counts.set(word, (counts.get(word) || 0) + 1);
    }
    const ending = words[words.length - 1];
    if (ending) endings.set(ending, (endings.get(ending) || 0) + 1);
  }
  const repeated = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([word]) => word);
  const repeatedEndings = [...endings.entries()]
    .filter(([, count]) => count >= 2)
    .map(([word]) => word);
  return [...new Set([...repeated, ...repeatedEndings, 'ya'])].slice(0, 16);
}

function withoutClosingYa(line) {
  const body = line.replace(/^[—–\-•]\s*/, '').replace(/\s+ya\s*[.!?…]*$/iu, '').trim();
  return body ? `—${body}` : line;
}

function buildMessages(languageKey) {
  const language = LANGUAGES[languageKey];
  const turn = PARADOX_TURNS[generationCount % PARADOX_TURNS.length];
  const recent = recentLines.slice(-8);
  const wornWords = wordsToAvoid(recentLines.slice(-16));
  const seed = language.title.join('\n');
  const guidance = [
    `This pair is about longing for: ${turn}.`,
    'Say it in ordinary, careful words. Both lines must be grammatical.',
    'The person wants to forget this, and remembers it anyway. The missing gets worse.',
    `Do not output these lines:\n${seed}`,
    recent.length ? `Do not repeat or paraphrase:\n${recent.join('\n')}` : '',
    wornWords.length ? `Do not use these words: ${wornWords.join(', ')}.` : '',
    languageKey === 'Español'
      ? 'En español: frases que una persona diría. Prohibido: ya, alma, polvo, eco, silencio, brillo, vacío.'
      : '',
    'Reply in the language of the user message. Do not print this note.'
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\n${guidance}` },
    { role: 'user', content: language.prompt }
  ];
}

function updateGenerationCounter() {
  const el = document.getElementById('generationCounter');
  if (!el) return;
  const color = (performanceMode || dMode)
    ? COLORS.performance.text.secondary
    : COLORS.theme.text.secondary;
  el.style.color = color;
  const label = generationCount === 1 ? 'generation' : 'generations';
  el.textContent = `${generationCount} ${label}`;
}

function recordGeneration(lines) {
  generationCount += 1;
  recentLines = [...recentLines, ...lines].slice(-MAX_RECENT_LINES);
  localStorage.setItem(GENERATION_COUNT_KEY, String(generationCount));
  localStorage.setItem(RECENT_LINES_KEY, JSON.stringify(recentLines));
  updateGenerationCounter();
}

function createGenerationCounter() {
  let counter = document.getElementById('generationCounter');
  if (!counter) {
    counter = document.createElement('div');
    counter.id = 'generationCounter';
    counter.style.position = 'fixed';
    counter.style.bottom = '20px';
    counter.style.right = '20px';
    counter.style.fontSize = '14px';
    counter.style.letterSpacing = '0.04em';
    counter.style.opacity = '0.8';
    counter.style.pointerEvents = 'none';
    document.body.appendChild(counter);
  }
  updateGenerationCounter();
}

function formatOllamaError(error) {
  const message = error?.message || '';
  if (/failed to fetch|networkerror|econnrefused/i.test(message)) {
    return 'Ollama is not running. Start Ollama, then press space.';
  }
  if (/not found/i.test(message)) {
    return `Model "${resolvedModel}" is not in Ollama. Run: ollama pull qwen3.5:27b`;
  }
  return message || 'Ollama request failed. Check the console.';
}

function resolveGemmaModel(models) {
  const names = (models || []).map((model) => model.name).filter(Boolean);
  const exact = names.find((name) => name === REQUESTED_MODEL || name === `${REQUESTED_MODEL}:latest`);
  if (exact) return exact;
  const prefixed = names.find((name) => name.startsWith(`${REQUESTED_MODEL}:`));
  if (prefixed) return prefixed;
  return names.find((name) => name.toLowerCase().startsWith('qwen3.5')) || null;
}

async function initializeOllama() {
  try {
    const response = await fetch(OLLAMA_TAGS_URL);
    if (!response.ok) {
      throw new Error(`Ollama responded ${response.status}`);
    }
    const data = await response.json();
    const model = resolveGemmaModel(data.models);
    if (!model) {
      ollamaReady = false;
      generationError = 'Qwen 3.5 is not in Ollama. Run: ollama pull qwen3.5:27b';
      console.error('❌', generationError);
      return false;
    }
    resolvedModel = model;
    ollamaReady = true;
    generationError = null;
    console.log('✅ Ollama ready. Using', resolvedModel);
    return true;
  } catch (error) {
    ollamaReady = false;
    generationError = formatOllamaError(error);
    console.error('❌ Failed to reach Ollama:', error);
    return false;
  }
}

function messageText(message) {
  if (!message) return '';
  const chunks = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) chunks.push(value);
    else if (Array.isArray(value)) value.forEach(push);
    else if (value && typeof value.text === 'string') chunks.push(value.text);
  };
  push(message.content);
  push(message.thinking);
  return chunks.join('\n');
}

function parseDialogue(content) {
  const cleaned = String(content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\w]*|```/g, '')
    .replace(/[\u200B\uFEFF]/g, '')
    .trim();

  const pieces = cleaned
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=\S)\s*(?=[—–―])/))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[\d]+[.)]\s*/, '').replace(/^["“”']+|["“”']+$/g, '').trim())
    .filter((line) => line && !/^(note|output|here|sure|claro|por supuesto)\b/i.test(line));

  const dashed = pieces
    .filter((line) => /^[—–―\-•]/.test(line))
    .map((line) => withoutClosingYa(line))
    .filter((line) => lineWords(line).length >= 2)
    .slice(0, 2);

  if (dashed.length >= 2) return dashed;

  const spoken = pieces
    .map((line) => withoutClosingYa(line))
    .filter((line) => {
      const count = lineWords(line).length;
      return count >= 2 && count <= 8;
    })
    .slice(0, 2);

  if (spoken.length >= 2) return spoken;

  const sentences = cleaned
    .replace(/^[—–―\-•]\s*/gm, '')
    .split(/[.!?…]+/)
    .map((line) => line.trim())
    .filter((line) => {
      const count = lineWords(line).length;
      return count >= 2 && count <= 8;
    })
    .slice(0, 2)
    .map((line) => withoutClosingYa(line));

  return sentences;
}

// Update constants
const GENERATION_INTERVAL = 12000; // 12 seconds between generations
const MAX_DIALOGUE_LENGTH = 16; // Keep more lines visible for slower fade
const TYPING_BASE_SPEED = 50;      // Slightly faster base typing
const PAUSE_BETWEEN_LINES = 1500;  // Longer pause between lines
const FADE_DURATION = 8000;        // Much longer fade transitions like slow memories
const BREATHING_SPEED = 0.005;     // Even slower breathing animation
const FLOATING_SPEED = 0.004;      // Even slower floating animation

// Remove scroll-related variables
let isLoading = true;
let sampleSound;
let isSoundPlaying = false;
let lastGenerationTime = 0;
let generationStarted = false; // Track if generation has been started by user

// Fade system variables
let currentGeneration = []; // Current generation being displayed
let generationStartTime = 0; // When current generation started
let generationAlpha = 0; // Alpha for current generation
let showingInterAnimation = false; // Show spiral between generations
let interAnimationStartTime = 0; // When inter-animation started
let generationError = null; // Error message when Ollama or Gemma cannot generate
const GENERATION_CYCLE = 10000; // 10 seconds between generations (shorter)
const FADE_IN_TIME = 2800;  // 2.8 s slow fade in
const DISPLAY_TIME = 600;   // 0.6 s fully visible
const FADE_OUT_TIME = 3200; // 3.2 s slow fade out
const PAUSE_AFTER_FADEOUT = 1600; // 1.6 s pause after fade out
const LINE_HEIGHT = 84; // Reduced by 30%
const FONT_SIZE = 67; // Reduced by 30%

// Scrolling layout - text appears at bottom and scrolls up
const CANVAS_HEIGHT = 700;
const BOTTOM_MARGIN = 100; // Space from bottom of canvas
const TOP_FADE_ZONE = 150; // Height of fade zone at top

// Add language configurations
const LANGUAGES = {
  'Español': {
    title: ["—¿Olvida usted algo?", "—Ojalá."],
    prompt: `Escribe dos líneas habladas en español. Cada una empieza con — y tiene de 2 a 4 palabras.
El tema es la añoranza: quiere olvidar y, a la vez, no deja de recordar. Esa contradicción hace más grande la falta.
Usa palabras sencillas, exactas y correctas. Como se habla. No inventes frases raras.
No copies el ejemplo. No termines con "ya".
—Extraño la casa.
—Quise olvidarla.`
  },
  'English': {
    title: ["—Forgettin' something?", "—If only."],
    prompt: `Create a very short, minimalist exchange (2-4 words each). Use em dashes. Make it feel like fragments:

—Let me forget it.
—It stays anyway.

Write a new exchange. Do not copy the example. The first line wants to forget. The second wishes that were possible, but memory stays and the missing hurts more. Each line under 4 words.`
  },
  'Français': {
    title: ["—Tu oublies quelque chose ?", "—Si seulement."],
    prompt: `Créez un très court échange minimaliste (2-4 mots chacun) en français. Utilisez des tirets. Que cela ressemble à des fragments:

—Laisse-moi l'oublier.
—Il reste quand même.

Écrivez un nouvel échange. Ne copiez pas l'exemple. La première ligne veut oublier. La seconde le souhaite, mais le souvenir reste et le manque empire. Chaque ligne sous 4 mots.`
  },
  'Deutsch': {
    title: ["—Vergisst du etwas?", "—Wenn nur."],
    prompt: `Erstelle einen sehr kurzen, minimalistischen Austausch (2-4 Wörter) auf Deutsch. Verwende Gedankenstriche. Es soll sich wie Fragmente anfühlen:

—Lass es mich vergessen.
—Es bleibt trotzdem.

Schreibe einen neuen Austausch. Kopiere das Beispiel nicht. Die erste Zeile will vergessen. Die zweite wünscht es, aber die Erinnerung bleibt und das Vermissen wird schärfer. Jede Zeile unter 4 Wörtern.`
  },
  'Italiano': {
    title: ["—Dimenticando qualcosa?", "—Se solo."],
    prompt: `Crea uno scambio minimalista molto breve (2-4 parole ciascuno) in italiano. Usa i trattini. Fallo sentire come frammenti:

—Lasciami dimenticarlo.
—Resta lo stesso.

Scrivi uno scambio nuovo. Non copiare l'esempio. La prima riga vuole dimenticare. La seconda lo desidera, ma il ricordo resta e la mancanza fa più male. Ogni riga sotto le 4 parole.`
  },
  'Português': {
    title: ["—Esquecendo algo?", "—Se ao menos."],
    prompt: `Crie uma troca minimalista muito curta (2-4 palavras cada) em português. Use travessões. Faça parecer fragmentos:

—Deixa eu esquecer.
—Ele fica assim.

Escreva uma troca nova. Não copie o exemplo. A primeira linha quer esquecer. A segunda deseja isso, mas a memória fica e a falta dói mais. Cada linha com menos de 4 palavras.`
  },
  '日本語': {
    title: ["—何か忘れてる？", "—ただそれだけ。"],
    prompt: `日本語で非常に短い、ミニマルな会話（各2-4語）を作成してください。ダッシュを使用し、断片的な感じにしてください：

—忘れさせて。
—それでも残る。

例は写さないで、新しい対話を書いてください。一行目は忘れたい。二行目はそれを願うが、記憶は残り、恋しさが増す。各行は4語以下。`
  },
  '中文': {
    title: ["—您忘了？", "—但愿如此！"],
    prompt: `用中文创建一个非常简短的对话 (每句2-4个字)。使用破折号。让它感觉像片段：

—让我忘掉。
—它还在。

写一对新的句子，不要抄例子。第一句想忘记。第二句但愿能忘，但记忆留下，思念更疼。每行不超过4个字。`
  },
  '한국어': {
    title: ["—뭔가 잊으셨나요?", "—그저 그뿐."],
    prompt: `한국어로 매우 짧은 미니멀한 대화(각 2-4단어)를 만드세요. 대시를 사용하고 단편적인 느낌이 들도록 하세요:

—잊게 해 줘.
—그래도 남아.

예문을 베끼지 말고 새 대화를 쓰세요. 첫 줄은 잊고 싶어 합니다. 둘째 줄은 그러길 바라지만, 기억은 남고 그리움은 더 아픕니다. 각 줄은 4단어 이하.`
  },
  'Русский': {
    title: ["—Что-то забыла?", "—Если бы."],
    prompt: `Создайте очень короткий, минималистичный обмен (2-4 слова каждый) на русском языке. Используйте тире. Пусть это звучит как фрагменты:

—Дай мне забыть.
—Оно всё равно здесь.

Напишите новый обмен. Не копируйте пример. Первая строка хочет забыть. Вторая желает этого, но память остаётся и тоска острее. Каждая строка короче 4 слов.`
  },
  'Українська': {
    title: ["—Щось забули?", "—Якби лише."],
    prompt: `Створіть дуже короткий, мінімалістичний обмін (2-4 слова кожне) українською. Використовуйте тире. Нехай це звучить як фрагменти:

—Дай мені забути.
—Воно все одно тут.

Напишіть новий обмін. Не копіюйте приклад. Перший рядок хоче забути. Другий бажає цього, але пам'ять лишається і туга гостріша. Кожен рядок коротше 4 слів.`
  },
  'العربية': {
    title: ["—هل نسيت شيئاً؟", "—لو فقط."],
    prompt: `أنشئ حواراً قصيراً للغاية (2-4 كلمات لكل سطر) بالعربية. استخدم الشرطات. اجعله يبدو كأجزاء متقطعة:

—دعني أنساه.
—يبقى رغم ذلك.

اكتب تبادلًا جديدًا. لا تنسخ المثال. السطر الأول يريد النسيان. الثاني يتمنى ذلك، لكن الذكرى تبقى والشوق يزداد. كل سطر تحت 4 كلمات.`
  },
  'हिंदी': {
    title: ["—कुछ भूल गए?", "—काश ऐसा होता।"],
    prompt: `हिंदी में एक बहुत छोटा, न्यूनतम संवाद बनाएं (प्रत्येक 2-4 शब्द)। डैश का उपयोग करें। इसे टुकड़ों की तरह महसूस कराएं:

—मुझे भूलने दो।
—वह फिर भी रहता है।

नया संवाद लिखें। उदाहरण नकल न करें। पहली पंक्ति भूलना चाहती है। दूसरी यही चाहती है, पर याद रहती है और कमी और दुखती है। हर पंक्ति 4 शब्दों से कम।`
  },
  'Ελληνικά': {
    title: ["—Ξεχνάς κάτι;", "—Μακάρι μόνο."],
    prompt: `Δημιούργησε μια πολύ σύντομη, μινιμαλιστική συνομιλία (2-4 λέξεις η καθεμία) στα ελληνικά. Χρησιμοποίησε παύλες. Κάνε το να μοιάζει με αποσπάσματα:

—Άσε με να το ξεχάσω.
—Μένει πάντως.

Γράψε μια νέα ανταλλαγή. Μην αντιγράψεις το παράδειγμα. Η πρώτη γραμμή θέλει να ξεχάσει. Η δεύτερη το εύχεται, μα η μνήμη μένει και ο καημός δυναμώνει. Κάθε γραμμή κάτω από 4 λέξεις.`
  },
  'Türkçe': {
    title: ["—Bir şey mi unuttun?", "—Keşke."],
    prompt: `Türkçe'de çok kısa, minimalist bir diyalog oluşturun (her biri 2-4 kelime). Kısa çizgi kullanın. Parçalar gibi hissettirin:

—Bırak unutayım.
—Yine de kalıyor.

Yeni bir alışveriş yaz. Örneği kopyalama. İlk satır unutmak ister. İkincisi bunu diler, ama anı kalır ve özlem daha keskin olur. Her satır 4 kelimenin altında.`
  },
  'Polski': {
    title: ["—Coś zapomniałeś?", "—Gdyby tylko."],
    prompt: `Stwórz bardzo krótką, minimalistyczną wymianę (2-4 słowa każda) po polsku. Użyj myślników. Niech brzmi jak fragmenty:

—Pozwól mi zapomnieć.
—A jednak zostaje.

Napisz nową wymianę. Nie kopiuj przykładu. Pierwsza linia chce zapomnieć. Druga tego pragnie, ale pamięć zostaje i tęsknota boli bardziej. Każda linia poniżej 4 słów.`
  },
  'Nederlands': {
    title: ["—Iets vergeten?", "—Was het maar zo."],
    prompt: `Maak een zeer korte, minimalistische uitwisseling (2-4 woorden elk) in het Nederlands. Gebruik gedachtestreepjes. Laat het aanvoelen als fragmenten:

—Laat me het vergeten.
—Het blijft toch.

Schrijf een nieuwe uitwisseling. Kopieer het voorbeeld niet. De eerste regel wil vergeten. De tweede wenst dat, maar de herinnering blijft en het gemis wordt scherper. Elke regel onder 4 woorden.`
  },
  'Svenska': {
    title: ["—Glömmer du något?", "—Om bara."],
    prompt: `Skapa ett mycket kort, minimalistiskt utbyte (2-4 ord vardera) på svenska. Använd tankstreck. Låt det kännas som fragment:

—Låt mig glömma det.
—Det stannar ändå.

Skriv ett nytt utbyte. Kopiera inte exemplet. Första raden vill glömma. Den andra önskar det, men minnet stannar och saknaden gör mer ont. Varje rad under 4 ord.`
  },
  'Čeština': {
    title: ["—Zapomněl jsi něco?", "—Kéž by jen."],
    prompt: `Vytvořte velmi krátkou, minimalistickou výměnu (2-4 slova každá) v češtině. Použijte pomlčky. Ať to působí jako fragmenty:

—Nech mě to zapomenout.
—Stejně zůstává.

Napište novou výměnu. Nepřepisujte příklad. První řádek chce zapomenout. Druhý si to přeje, ale vzpomínka zůstává a stesk bolí víc. Každý řádek pod 4 slovy.`
  },
  'Tiếng Việt': {
    title: ["—Quên gì à?", "—Giá mà thế."],
    prompt: `Tạo một cuộc trao đổi rất ngắn, tối giản (mỗi câu 2-4 từ) bằng tiếng Việt. Sử dụng dấu gạch ngang. Làm cho nó có cảm giác như những mảnh ghép:

—Hãy để tôi quên.
—Nó vẫn ở lại.

Viết một cặp mới. Đừng chép ví dụ. Dòng đầu muốn quên. Dòng sau ước được vậy, nhưng ký ức còn và nỗi nhớ đau hơn. Mỗi dòng dưới 4 từ.`
  },
  'ไทย': {
    title: ["—ลืมอะไรหรือเปล่า?", "—ถ้าเพียงแค่นั้น"],
    prompt: `สร้างบทสนทนาสั้นๆ แบบมินิมอล (2-4 คำต่อบรรทัด) ในภาษาไทย ใช้เครื่องหมายขีด ให้รู้สึกเหมือนเป็นส่วนๆ:

—ให้ฉันลืมมัน
—มันก็ยังอยู่

เขียนบทใหม่ อย่าคัดลอกตัวอย่าง บรรทัดแรกอยากลืม บรรทัดหลังปรารถนาเช่นนั้น แต่ความจำอยู่ และความคิดถึงเจ็บกว่า แต่ละบรรทัดไม่เกิน 4 คำ`
  },
  'Kiswahili': {
    title: ["—Umekosea kitu?", "—Laiti."],
    prompt: `Tengeneza mabadiliko mafupi, maana (maneno 2-4 kila mmoja) kwa Kiswahili. Tumia mstari mrefu. Lihisi kama vipande:

—Niache nisahau.
—Bado kinabaki.

Andika mabadiliko mapya. Usinakili mfano. Mstari wa kwanza unataka kusahau. Wa pili unatamani hivyo, lakini kumbukumbu inabaki na kukosa kunauma zaidi. Kila mstari chini ya maneno 4.`
  },
  'Yoruba': {
    title: ["—Ṣe o gbàgbé nǹkan?", "—Bóyá."],
    prompt: `Ṣe àkójọpọ kukuru, aláìlòpọ (ọrọ 2-4 kọọkan) ní èdè Yorùbá. Lo àfojúrí. Jẹ kó rúwé bí àwọn apá:

—Jẹ́ kí n gbàgbé.
—Ó ṣì wà.

Kọ àkójọpọ tuntun. Má ṣe da àpẹẹrẹ. Ìlà kìnní fẹ́ gbàgbé. Ìkejì fẹ́ bẹ́ẹ̀, ṣùgbọ́n ìrántí wà, àìrí sì dun sí i. Ọ̀rọ̀ kọ̀ọ̀kan kéré ju 4.`
  },
  'Amharic': {
    title: ["—አንድ ነገር ረሱ?", "—እንደሆነ ኖሮ."],
    prompt: `በአማርኛ በጣም አጭር እና ዝቅተኛ ልውውጥ (2-4 ቃላት እያንዳንዱ) ፍጠር። ረጅም መስመር ተጠቀም። እንደ ቁርጥራጮች ይሰማ።

—ልርሳው።
—ቢሆንም ይቀራል።

አዲስ ልውውጥ ጻፍ። ምሳሌውን አትቅዳ። የመጀመሪያው መስመር መርሳት ይፈልጋል። ሁለተኛው ያንን ይመኛል፣ ነገር ግን ትዝታው ይቀራል እና ናፍቆቱ ይጎዳል። እያንዳንዱ መስመር ከ4 ቃላት በታች።`
  },
  'isiZulu': {
    title: ["—Ukhohliwe into?", "—Kube ngabe."],
    prompt: `Dala ukushintshanisa okufushane, okuncane (amagama 2-4 ngamunye) ngesiZulu. Sebenzisa umugqa omude. Kuzwe njengeziqephu:

—Ake ngikhohlwe.
—Kusalokhu kukuhlezi.

Bhala ukushintshana okusha. Ungakopishi isibonelo. Ulayini wokuqala ufuna ukukhohlwa. Owesibili ukufisa lokho, kodwa inkumbulo iyahlala nokukhumbula kubuhlungu kakhulu. Umugqa ngamunye ungaphansi kwamagama ama-4.`
  }
};

// Color system — grayscale only (black, white, gray)
const COLORS = {
  // Base palette (grayscale)
  base: {
    white: '#f5f5f5',
    black: '#000000',
    dark: '#111111',
    midDark: '#2a2a2a',
    mid: '#666666',
    midLight: '#999999',
    light: '#b0b0b0',
    offWhite: '#e8e8e8'
  },
  
  // Functional colors
  theme: {
    background: '#111111',
    text: {
      primary: '#f5f5f5',
      secondary: '#999999',
      accent: '#b0b0b0'
    },
    interactive: {
      hover: '#999999',
      active: '#444444',
      focus: '#666666'
    }
  },
  
  // State-based combinations
  states: {
    typing: {
      color: '#999999',
      shadow: '#444444'
    },
    loading: {
      primary: '#666666',
      secondary: '#f5f5f5'
    },
    fading: {
      start: '#f5f5f5',
      end: '#444444'
    }
  },
  
  // Performance mode theme (dark grayscale)
  performance: {
    background: '#000000',
    text: {
      primary: '#ffffff',
      secondary: '#cccccc',
      accent: '#ffffff'
    },
    loading: {
      primary: '#ffffff',
      secondary: '#666666'
    }
  }
};

// Change default language to use the selected language from landing page
let currentLanguage = localStorage.getItem('selectedLanguage') || 'Español';
let isStarted = true; // Start immediately

// Performance mode variables
let performanceMode = false;
let performanceLanguageIndex = 0;
// All languages except Spanish; performance cycle = Español then each other in turn (always back to Spanish)
const OTHER_LANGUAGES = Object.keys(LANGUAGES).filter(lang => lang !== 'Español');
const PERFORMANCE_CYCLE = OTHER_LANGUAGES.flatMap(lang => ['Español', lang]);

// D mode: Spanish ↔ English only (same speed and installation as P mode)
let dMode = false;
let dModeLanguageIndex = 0;
const D_MODE_CYCLE = ['Español', 'English'];

// Add typing effect variables
let isTyping = false;
let currentTypingIndex = 0;
let typingSpeed = 50; // milliseconds per character
let lastTypingTime = 0;
let currentTypingLines = [];

// Add rhythm variables
let typingVariation = 0;
let pauseStartTime = 0;
let isPaused = false;

// Add easing functions for smoother animations
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
const easeInOutQuad = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 4;

// Simple text generation
async function generateText(p) {
  if (generationInFlight) return;
  generationInFlight = true;

  try {
    console.log('🎯 Generating new text...');
    isLoading = true;
    
    // D mode: Spanish → English → Spanish → English only
    if (dMode) {
      currentLanguage = D_MODE_CYCLE[dModeLanguageIndex];
      dModeLanguageIndex = (dModeLanguageIndex + 1) % D_MODE_CYCLE.length;
      syncLanguageMenuToCurrent();
      console.log('🌍 D mode: language', currentLanguage);
    }
    // P mode: all languages, always back to Spanish
    else if (performanceMode) {
      currentLanguage = PERFORMANCE_CYCLE[performanceLanguageIndex];
      performanceLanguageIndex = (performanceLanguageIndex + 1) % PERFORMANCE_CYCLE.length;
      syncLanguageMenuToCurrent();
      console.log('🌍 Performance mode: language', currentLanguage,
                  '(', performanceLanguageIndex, '/', PERFORMANCE_CYCLE.length, ')');
    }
    
    if (!ollamaReady) {
      const ready = await initializeOllama();
      if (!ready) {
        generationStarted = false;
        return;
      }
    }
    generationError = null;
    
    console.log('📡 Asking', resolvedModel, 'via Ollama...');
    const response = await fetch(OLLAMA_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: resolvedModel,
        stream: false,
        think: false,
        messages: buildMessages(currentLanguage),
        options: {
          temperature: 0.7,
          top_p: 0.85,
          repeat_penalty: 1.15,
          num_predict: 256
        }
      })
    });

    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        detail = body?.error || '';
      } catch {
        detail = await response.text();
      }
      throw new Error(detail || `Ollama responded ${response.status}`);
    }

    const completion = await response.json();
    const content = messageText(completion?.message);
    console.log('📝 Raw model response:', content);

    const newLines = parseDialogue(content);
    if (newLines.length < 2) {
      throw new Error('The model did not return a two-line dialogue. Press space to try again.');
    }
    
    console.log('✨ New generation ready:', newLines);
    recordGeneration(newLines);
    
    // Start new fade cycle
    currentGeneration = newLines;
    generationStartTime = p.millis();
    generationAlpha = 0;
    showingInterAnimation = false; // Turn off inter-animation
    
    console.log('🌅 Started new fade cycle');
  } catch (error) {
    console.error('❌ Error generating text:', error);
    generationError = formatOllamaError(error);
    generationStarted = false;
  } finally {
    isLoading = false;
    generationInFlight = false;
  }
}

// Store p5 instance reference
let p5Instance;

// Function to update UI colors based on performance mode
function updateUIColors() {
  const select = document.getElementById('languageSelect');
  const homeLink = document.getElementById('homeLink');
  
  if (select) {
    const bgColor = (performanceMode || dMode) ? COLORS.performance.background : COLORS.theme.background;
    const textColor = (performanceMode || dMode) ? COLORS.performance.text.primary : COLORS.theme.text.primary;
    const borderColor = (performanceMode || dMode) ? COLORS.performance.text.secondary : COLORS.theme.interactive.hover;
    
    select.style.backgroundColor = bgColor;
    select.style.color = textColor;
    select.style.borderColor = borderColor;
  }
  
  if (homeLink) {
    const bgColor = (performanceMode || dMode) ? COLORS.performance.background : COLORS.theme.background;
    const textColor = (performanceMode || dMode) ? COLORS.performance.text.primary : COLORS.theme.text.primary;
    const borderColor = (performanceMode || dMode) ? COLORS.performance.text.secondary : COLORS.theme.interactive.hover;
    
    homeLink.style.backgroundColor = bgColor;
    homeLink.style.color = textColor;
    homeLink.style.borderColor = borderColor;
  }

  updateGenerationCounter();
}

// Sync the language dropdown to currentLanguage (e.g. when performance mode sets next language)
function syncLanguageMenuToCurrent() {
  const select = document.getElementById('languageSelect');
  if (select && currentLanguage && select.value !== currentLanguage) {
    select.value = currentLanguage;
  }
}

// Update language selection function to remember user's choice
function createLanguageMenu(p) {
  const select = document.createElement('select');
  select.id = 'languageSelect'; // Add ID for updateUIColors function
  select.style.position = 'fixed';
  select.style.top = '20px';
  select.style.right = '20px';
  select.style.padding = '8px';
  select.style.fontSize = '16px';
  const bgColor = (performanceMode || dMode) ? COLORS.performance.background : COLORS.theme.background;
  const textColor = (performanceMode || dMode) ? COLORS.performance.text.primary : COLORS.theme.text.primary;
  const borderColor = (performanceMode || dMode) ? COLORS.performance.text.secondary : COLORS.theme.interactive.hover;
  
  select.style.backgroundColor = bgColor;
  select.style.color = textColor;
  select.style.border = `2px solid ${borderColor}`;
  select.style.borderRadius = '4px';
  select.style.cursor = 'pointer';
  
  // Add hover effects
  select.addEventListener('mouseover', () => {
    const hoverBorderColor = (performanceMode || dMode) ? COLORS.performance.text.primary : COLORS.theme.interactive.hover;
    const hoverTextColor = (performanceMode || dMode) ? COLORS.performance.text.secondary : COLORS.theme.text.secondary;
    select.style.borderColor = hoverBorderColor;
    select.style.color = hoverTextColor;
  });
  
  select.addEventListener('mouseout', () => {
    const normalBorderColor = (performanceMode || dMode) ? COLORS.performance.text.secondary : COLORS.theme.interactive.focus;
    const normalTextColor = (performanceMode || dMode) ? COLORS.performance.text.primary : COLORS.theme.text.primary;
    select.style.borderColor = normalBorderColor;
    select.style.color = normalTextColor;
  });
  
  Object.keys(LANGUAGES).forEach(lang => {
    const option = document.createElement('option');
    option.value = lang;
    option.text = lang;
    if (lang === currentLanguage) { // Use the stored language
      option.selected = true;
    }
    select.appendChild(option);
  });
  
  select.addEventListener('change', (e) => {
    currentLanguage = e.target.value;
    localStorage.setItem('selectedLanguage', currentLanguage); // Store the new selection
    // Don't reset anything - using fade system now
    generateText(p);
    lastGenerationTime = p.millis();
  });
  
  document.body.appendChild(select);
}

// Add streaming-related variables
let currentStreamText = '';
let targetText = '';
let streamIndex = 0;
const STREAM_SPEED = 2; // Letters per frame

// Add animation variables
let fadeStartTime = 0;

// Add instructions for user interaction
function createInstructions(p) {
  const instructions = document.createElement('div');
  instructions.innerHTML = `
    <div style="position: fixed; bottom: 20px; left: 20px; font-size: 14px; color: ${COLORS.theme.text.secondary}; opacity: 0.8;">
      <div>Press <strong>SPACE</strong> to generate new dialogue</div>
      <div>Press <strong>P</strong> to toggle audio</div>
    </div>
  `;
  document.body.appendChild(instructions);
}

// Add this near the top where other UI elements are created
function createHomeLink(p) {
  const homeLink = document.createElement('a');
  homeLink.id = 'homeLink'; // Add ID for updateUIColors function
  homeLink.textContent = '← Home';
  homeLink.style.position = 'fixed';
  homeLink.style.top = '20px';
  homeLink.style.left = '20px';
  homeLink.style.padding = '8px';
  homeLink.style.fontSize = '16px';
  const homeBgColor = (performanceMode || dMode) ? COLORS.performance.background : COLORS.theme.background;
  const homeTextColor = (performanceMode || dMode) ? COLORS.performance.text.primary : COLORS.theme.text.primary;
  const homeBorderColor = (performanceMode || dMode) ? COLORS.performance.text.secondary : COLORS.theme.interactive.hover;
  
  homeLink.style.backgroundColor = homeBgColor;
  homeLink.style.color = homeTextColor;
  homeLink.style.border = `2px solid ${homeBorderColor}`;
  homeLink.style.borderRadius = '4px';
  homeLink.style.cursor = 'pointer';
  homeLink.style.textDecoration = 'none';
  homeLink.href = '#';
  
  // Add hover effects
  homeLink.addEventListener('mouseover', () => {
    const homeHoverBorderColor = (performanceMode || dMode) ? COLORS.performance.text.primary : COLORS.theme.interactive.hover;
    const homeHoverTextColor = (performanceMode || dMode) ? COLORS.performance.text.secondary : COLORS.theme.text.secondary;
    homeLink.style.borderColor = homeHoverBorderColor;
    homeLink.style.color = homeHoverTextColor;
  });
  
  homeLink.addEventListener('mouseout', () => {
    const homeNormalBorderColor = (performanceMode || dMode) ? COLORS.performance.text.secondary : COLORS.theme.interactive.focus;
    const homeNormalTextColor = (performanceMode || dMode) ? COLORS.performance.text.primary : COLORS.theme.text.primary;
    homeLink.style.borderColor = homeNormalBorderColor;
    homeLink.style.color = homeNormalTextColor;
  });
  
  homeLink.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('app').style.display = 'none';
    document.getElementById('landing').style.display = 'flex';
    
    // Reset landing page language to Spanish
    currentLandingLanguage = 'Español';
    updateLandingText();
    
    // Clear the stored language
    localStorage.removeItem('selectedLanguage');
  });
  
  document.body.appendChild(homeLink);
}

const sketch = p => {
  p5Instance = p;  // Store the p5 instance

  p.preload = function() {
    sampleSound = p.loadSound('/sample.mp3');
  };

  p.setup = function() {
    console.log('🎪 P5 Setup starting...');
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.fill(p.color(COLORS.theme.text.primary)); // Default text color
    p.textSize(FONT_SIZE);
    
    // No dialogue history needed - using fade system now
    createLanguageMenu(p);
    createHomeLink(p);
    createInstructions(p);
    createGenerationCounter();
    
    // Show spiral animation for 2 seconds, then automatically start generation
    setTimeout(async () => {
      console.log('🔧 Checking Ollama...');
      const isOllamaReady = await initializeOllama();
      if (isOllamaReady) {
        console.log('✅ Ollama ready. Auto-starting generation...');
        isLoading = false;
        generationStarted = true;
        lastGenerationTime = p.millis();
        
        // Start first generation immediately
        setTimeout(() => {
          console.log('🎯 Auto-starting first generation...');
          generateText(p);
        }, 100);
      } else {
        console.log('❌ Ollama is not ready. Cannot start generation.');
        isLoading = false;
      }
    }, 2000); // 2 second spiral animation, then auto-start
    
    // Add global key listener as backup
    document.addEventListener('keydown', (event) => {
      console.log('🌐 Global keydown - code:', event.code, 'key:', event.key, 'keyCode:', event.keyCode);
      if (event.code === 'Space' || event.key === ' ' || event.keyCode === 32) {
        console.log('🌐 Global Space detected!');
        event.preventDefault(); // Prevent default space behavior
        
        if (!generationStarted) {
          console.log('🚀 Starting generation!');
          generationStarted = true;
          lastGenerationTime = p.millis();
          
          // Start first generation immediately
          setTimeout(() => {
            console.log('🎯 Starting first generation...');
            generateText(p);
          }, 10);
        } else {
          // Manual generation trigger
          setTimeout(() => {
            console.log('🎯 Manual generation trigger...');
            generateText(p);
          }, 10);
        }
      }
    });
    
    // Add click listener as alternative to start generation
    document.addEventListener('click', () => {
      if (!generationStarted) {
        console.log('🖱️ Starting generation!');
        generationStarted = true;
        lastGenerationTime = p.millis();
        setTimeout(() => {
          console.log('🎯 Click - starting first generation...');
          generateText(p);
        }, 10);
      }
    });
    
    console.log('✅ P5 Setup complete');
  };

  p.keyPressed = function() {
    console.log('🎹 Key pressed - keyCode:', p.keyCode, 'key:', p.key);
    if (p.keyCode === 80) { // 'P' key - performance mode: music + all languages cycling
      performanceMode = !performanceMode;
      if (performanceMode) dMode = false; // P and D are exclusive
      updateUIColors();
      if (performanceMode) {
        if (sampleSound) {
          sampleSound.loop();
          isSoundPlaying = true;
          console.log('🔊 Performance mode: music on');
        }
        performanceLanguageIndex = 0;
        currentLanguage = PERFORMANCE_CYCLE[0];
        syncLanguageMenuToCurrent();
        if (!generationStarted) {
          generationStarted = true;
          lastGenerationTime = p.millis();
          setTimeout(() => generateText(p), 10);
          console.log('🎭 Performance mode: generation started, cycling languages');
        } else {
          console.log('🎭 Performance mode: language cycle reset to Spanish');
        }
      } else {
        if (sampleSound) {
          sampleSound.stop();
          isSoundPlaying = false;
          console.log('🔇 Performance mode off: music stopped');
        }
      }
    } else if (p.keyCode === 68) { // 'D' key - D mode: Spanish ↔ English only, same speed as P
      dMode = !dMode;
      if (dMode) performanceMode = false;
      updateUIColors();
      if (dMode) {
        if (sampleSound) {
          sampleSound.loop();
          isSoundPlaying = true;
          console.log('🔊 D mode: music on');
        }
        dModeLanguageIndex = 0;
        currentLanguage = D_MODE_CYCLE[0]; // Español
        syncLanguageMenuToCurrent();
        if (!generationStarted) {
          generationStarted = true;
          lastGenerationTime = p.millis();
          setTimeout(() => generateText(p), 10);
          console.log('🎭 D mode: generation started, Spanish ↔ English');
        } else {
          console.log('🎭 D mode: cycle reset to Spanish');
        }
      } else {
        if (sampleSound) {
          sampleSound.stop();
          isSoundPlaying = false;
          console.log('🔇 D mode off: music stopped');
        }
      }
    } else if (p.keyCode === 32 || p.key === ' ') { // Space bar (check both keyCode and key)
      console.log('✅ Space detected! generationStarted:', generationStarted);
      if (!generationStarted) {
        console.log('🚀 Starting generation!');
        generationStarted = true;
        lastGenerationTime = p.millis();
        
        // Start first generation immediately
        setTimeout(() => {
          console.log('🎯 Space - starting first generation...');
          generateText(p);
        }, 10);
      } else {
        // Manual generation trigger
        setTimeout(() => {
          console.log('🎯 Space - manual generation...');
          generateText(p);
        }, 10);
      }
    } else {
      console.log('❓ Unhandled key:', p.keyCode, p.key);
    }
  };

  p.draw = function() {
    // Use performance mode colors if active
    const bgColor = (performanceMode || dMode) ? COLORS.performance.background : COLORS.theme.background;
    p.background(p.color(bgColor));

    if (isLoading) {
      displayLoader(p);
    } else if (generationError) {
      // Show error message if generation failed (e.g. missing API key)
      const primaryTextColor = (performanceMode || dMode) ? COLORS.performance.text.primary : COLORS.theme.text.primary;
      p.fill(primaryTextColor);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(18);
      p.text(generationError, p.width / 2, p.height / 2);
      p.textSize(14);
      p.text('Press space to try again', p.width / 2, p.height / 2 + 32);
    } else if (!generationStarted) {
      // Show waiting message if generation hasn't started
      displayWaitingMessage(p);
    } else {
      // Debug only when stuck (started but no text and no start time)
      if (p.frameCount % 120 === 0 && currentGeneration.length === 0 && generationStartTime === 0) {
        console.log('🔍 Waiting for first generation…', { generationStarted, generationError });
      }
      
      // Fade in/out system for generations
      if (currentGeneration.length > 0) {
        const elapsed = p.millis() - generationStartTime;
        
        // Calculate alpha based on fade cycle
        if (elapsed < FADE_IN_TIME) {
          // Fade in
          generationAlpha = p.map(elapsed, 0, FADE_IN_TIME, 0, 255);
        } else if (elapsed < FADE_IN_TIME + DISPLAY_TIME) {
          // Fully visible
          generationAlpha = 255;
        } else if (elapsed < FADE_IN_TIME + DISPLAY_TIME + FADE_OUT_TIME) {
          // Fade out
          const fadeOutStart = FADE_IN_TIME + DISPLAY_TIME;
          const fadeOutEnd = fadeOutStart + FADE_OUT_TIME;
          generationAlpha = p.map(elapsed, fadeOutStart, fadeOutEnd, 255, 0);
        } else if (elapsed < FADE_IN_TIME + DISPLAY_TIME + FADE_OUT_TIME + PAUSE_AFTER_FADEOUT) {
          // Pause after fade out - text is completely gone
          currentGeneration = [];
          generationAlpha = 0;
        } else {
          // Cycle complete - start spiral animation after pause
          currentGeneration = [];
          generationAlpha = 0;
          showingInterAnimation = true;
          interAnimationStartTime = p.millis();
        }
        
        // Display current generation
        p.push();
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(FONT_SIZE);
        
        // Use performance mode colors if active
        const primaryTextColor = (performanceMode || dMode) ? COLORS.performance.text.primary : COLORS.theme.text.primary;
        const textColor = p.color(primaryTextColor);
        textColor.setAlpha(generationAlpha);
        p.fill(textColor);
        
        // Center the generation vertically and horizontally
        const totalHeight = currentGeneration.length * LINE_HEIGHT;
        const startY = (p.height / 2) - (totalHeight / 2) + (LINE_HEIGHT / 2);
        
        currentGeneration.forEach((line, i) => {
          const yPos = startY + (i * LINE_HEIGHT);
          p.text(line, Math.floor(p.width / 2), Math.floor(yPos));
        });
        
        p.pop();
      } else if (showingInterAnimation) {
        // Show spiral animation between generations with fade
        const interElapsed = p.millis() - interAnimationStartTime;
        const INTER_FADE_TIME = 500;  // 0.5 s fade in/out
        const INTER_DISPLAY_TIME = 600; // 0.6 s fully visible
        const INTER_TOTAL_TIME = INTER_FADE_TIME + INTER_DISPLAY_TIME + INTER_FADE_TIME;
        
        let interAlpha;
        if (interElapsed < INTER_FADE_TIME) {
          // Fade in
          interAlpha = interElapsed / INTER_FADE_TIME;
        } else if (interElapsed < INTER_FADE_TIME + INTER_DISPLAY_TIME) {
          // Fully visible
          interAlpha = 1.0;
        } else if (interElapsed < INTER_TOTAL_TIME) {
          // Fade out
          const fadeOutStart = INTER_FADE_TIME + INTER_DISPLAY_TIME;
          interAlpha = 1.0 - ((interElapsed - fadeOutStart) / INTER_FADE_TIME);
        } else {
          // Animation complete - hide it
          showingInterAnimation = false;
          interAlpha = 0;
        }
        
        if (interAlpha > 0) {
          displayLoader(p, interAlpha);
        }
      } else {
        // No text when no generation is active - just empty space
      }
      
      // Auto-generate new text when cycle time elapsed
      if (generationStarted && p.millis() - lastGenerationTime > GENERATION_CYCLE) {
        console.log('⏰ Starting new generation cycle');
        setTimeout(() => {
          generateText(p);
        }, 10);
        lastGenerationTime = p.millis();
      }
    }
  };

  p.windowResized = function() {
    p.resizeCanvas(p.windowWidth, p.windowHeight);
  };
};

// Display waiting message before generation starts
function displayWaitingMessage(p) {
  p.push();
  p.textAlign(p.CENTER, p.CENTER);
  p.textSize(FONT_SIZE * 0.6);
  
  // Simple centered message - no original phrases shown
  // Use performance mode colors if active
  const accentTextColor = (performanceMode || dMode) ? COLORS.performance.text.accent : COLORS.theme.text.accent;
  const instructionColor = p.color(accentTextColor);
  const instructionAlpha = Math.sin(p.frameCount * 0.03) * 0.3 + 0.7;
  instructionColor.setAlpha(255 * instructionAlpha);
  p.fill(instructionColor);
  
  p.text("Preparing memories...", Math.floor(p.width/2), Math.floor(p.height/2));
  
  p.pop();
}

// Spiral animation representing time passing - no text, just movement
function displayLoader(p, globalAlpha = 1.0) {
  p.push();
  p.translate(Math.floor(p.width / 2), Math.floor(p.height / 2));
  
  // Spiral parameters
  const time = p.frameCount * 0.03; // Slow, meditative speed
  const numDots = 12; // More dots for a fuller spiral
  const maxRadius = 60; // Spiral expands to this radius
  
  for (let i = 0; i < numDots; i++) {
    // Each dot follows the spiral at different points in time
    const dotTime = time - (i * 0.3); // Stagger each dot
    
    // Spiral mathematics: expanding outward over time
    const angle = dotTime * 2; // Rotation speed
    const radius = (dotTime % 4) * (maxRadius / 4); // Spiral outward, then reset
    
    // Calculate position
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    
    // Fade in as dot moves outward, fade out as it reaches edge
    const radiusProgress = (radius / maxRadius);
    let alpha;
    if (radiusProgress < 0.3) {
      // Fade in
      alpha = radiusProgress / 0.3;
    } else if (radiusProgress < 0.7) {
      // Fully visible
      alpha = 1;
    } else {
      // Fade out
      alpha = 1 - ((radiusProgress - 0.7) / 0.3);
    }
    
    // Only draw if dot is visible and in valid position
    if (alpha > 0 && radius >= 0) {
      // Use performance mode colors if active
      const secondaryTextColor = (performanceMode || dMode) ? COLORS.performance.text.secondary : COLORS.theme.text.secondary;
      const dotColor = p.color(secondaryTextColor);
      dotColor.setAlpha(255 * alpha * 0.8 * globalAlpha); // Apply global fade
      p.fill(dotColor);
      p.noStroke();
      
      // Larger dots as requested
      const dotSize = 8 + (alpha * 4); // 8-12 pixels diameter
      p.ellipse(x, y, dotSize, dotSize);
    }
  }
  
  p.pop();
}

function onReady() {
  const mainElt = document.querySelector('main');
  new p5(sketch, mainElt);
}

if (document.readyState === 'complete') {
  onReady();
} else {
  document.addEventListener("DOMContentLoaded", onReady);
}



