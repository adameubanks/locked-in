let tts = null;
const kokoro = () => tts || (tts = import("kokoro-js")
  .then(k => k.KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "fp32", device: "cpu" }))
  .catch(e => { tts = null; throw e; }));

process.parentPort.on("message", async ({ data: { id, text, voice, speed } }) => {
  try {
    const k = await kokoro();
    process.parentPort.postMessage({ id, ok: text == null ? k.voices : (await k.generate(text, { voice, speed })).toWav() });
  } catch (e) {
    process.parentPort.postMessage({ id, err: (e && e.message) || String(e) });
  }
});
