/* The timestamped Kokoro also returns how long each phoneme lasts, which
   puts a start time on every word of the page text. */
let tts = null;
const kokoro = () => tts || (tts = import("kokoro-js").then(async ({ KokoroTTS }) => {
  const k = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX-timestamped", { dtype: "fp32", device: "cpu" });
  const run = k.model, tok = k.tokenizer;
  k.model = async i => (k.out = await run(i));
  k.tokenizer = (p, o) => tok(k.ph = p, o);
  k.n = w => tok(w, { add_special_tokens: false }).input_ids.dims.at(-1);
  return k;
}).catch(e => { tts = null; throw e; }));

process.parentPort.on("message", async ({ data: { id, words, voice, speed } }) => {
  try {
    const k = await kokoro();
    if (!words) return process.parentPort.postMessage({ id, ok: k.voices });
    const a = await k.generate(words.filter(Boolean).join(" "), { voice, speed });
    const d = k.out.durations.data, sec = a.audio.length / a.sampling_rate / d.reduce((s, x) => s + x, 0);
    const starts = [];
    let p = 1, t = d[0];
    for (const w of k.ph.split(" ")) { starts.push(t * sec); for (const e = p + k.n(w) + 1; p < e;) t += d[p++]; }
    // a page word can be several spoken ones ("4.4"), so count each and spread any mismatch
    const { phonemize } = await import("phonemizer"), c = [];
    for (const w of words) {
      const x = w.replace(/\.(?!\d)|[^\w.']/g, "").toLowerCase();
      c.push(x ? (await phonemize(x, "en-us")).join(" ").split(/\s+/).filter(Boolean).length : 0);
    }
    const total = c.reduce((s, x) => s + x, 0) || 1;
    let acc = 0;
    const times = c.map(x => starts[Math.min(starts.length - 1, Math.round(((acc += x) - x) * starts.length / total))]);
    process.parentPort.postMessage({ id, ok: { wav: a.toWav(), times } });
  } catch (e) {
    process.parentPort.postMessage({ id, err: (e && e.message) || String(e) });
  }
});
