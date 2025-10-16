// tts func

// index.js (CommonJS, Node.js 20.x)
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const crypto = require("crypto");

// ----- Config (env) -----
const REGION = process.env.AWS_REGION || "eu-central-1";
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;            // required
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || "Joanna";

const polly = new PollyClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

module.exports.handler = async (event) => {
  // Handle CORS preflight quickly (API Gateway HTTP API may send OPTIONS)
  if (event?.requestContext?.http?.method === "OPTIONS") {
    return cors(200, { ok: true });
  }

  try {
    const body = event?.isBase64Encoded
      ? JSON.parse(Buffer.from(event.body, "base64").toString())
      : JSON.parse(event?.body || "{}");

    const text   = (body.text || "").toString().trim();     // may be plain text or SSML
    const voice  = (body.voiceId || DEFAULT_VOICE).toString();
    const rate   = (body.rate || "medium").toString();      // e.g. "medium", "+10%", "-5%"
    const pitch  = (body.pitch || "medium").toString();     // e.g. "medium", "+2st", "-2st"
    const engineReq = (body.engine || "").toString().toLowerCase(); // "standard" to force Standard

    if (!OUTPUT_BUCKET) return cors(500, { message: "OUTPUT_BUCKET env var is not set" });
    if (!text)         return cors(400, { message: "Please provide non-empty 'text'." });

    // If user already sent SSML (<speak>...), pass through; else wrap with rate/pitch.
    const { Text, TextType } = wrapSSML(text, rate, pitch);

    // Try Generative → Neural → Standard (or force Standard if requested)
    const pollyResp = await synthesizeWithFallback(
      { Text, TextType, VoiceId: voice, OutputFormat: "mp3" },
      engineReq === "standard"
    );

    if (!pollyResp.AudioStream) throw new Error("Polly did not return audio data");

    // Upload to S3
    const audioBuffer = await streamToBuffer(pollyResp.AudioStream);
    const key = `web/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp3`;

    await s3.send(new PutObjectCommand({
      Bucket: OUTPUT_BUCKET,
      Key: key,
      Body: audioBuffer,
      ContentType: "audio/mpeg",
      ContentLength: audioBuffer.length,
    }));

    // Pre-signed URL (1 hour)
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: OUTPUT_BUCKET, Key: key }), { expiresIn: 3600 });

    return cors(200, { url, key, voiceId: voice, region: REGION });
  } catch (err) {
    console.error(err);
    return cors(500, { message: "Failed to synthesize", error: err.message });
  }
};

// ---------- Helpers ----------

// Try Generative → Neural → Standard, unless forceStandard=true.
async function synthesizeWithFallback(baseParams, forceStandard = false) {
  if (!forceStandard) {
    // 1) Generative
    try {
      return await polly.send(new SynthesizeSpeechCommand({ ...baseParams, Engine: "generative" }));
    } catch (eGen) {
      console.warn("Generative not supported; trying Neural:", eGen?.message || eGen);
      // 2) Neural
      try {
        return await polly.send(new SynthesizeSpeechCommand({ ...baseParams, Engine: "neural" }));
      } catch (eNeu) {
        console.warn("Neural not supported; falling back to Standard:", eNeu?.message || eNeu);
      }
    }
  }
  // 3) Standard
  return await polly.send(new SynthesizeSpeechCommand({ ...baseParams, Engine: "standard" }));
}

// Wrap plain text with SSML prosody; if already SSML, pass through.
function wrapSSML(text, rate, pitch) {
  if (/<\s*speak[\s>]/i.test(text)) return { Text: text, TextType: "ssml" };
  const esc = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const ssml = `<speak><prosody rate="${rate}" pitch="${pitch}">${esc(text)}</prosody></speak>`;
  return { Text: ssml, TextType: "ssml" };
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}
