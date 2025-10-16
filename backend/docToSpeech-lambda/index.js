// docToSpeech - S3 trigger: reads .txt/.md -> Polly -> writes MP3 parts + manifest
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const REGION = process.env.AWS_REGION || "eu-central-1";
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;

const polly = new PollyClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

const MAX_CHARS = 3000; // keep under Polly’s per-request limits

module.exports.handler = async (event) => {
  for (const record of event.Records || []) {
    try {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
      if (!/\.(txt|md)$/i.test(key)) continue; // ignore other files

      // 1) Read the text + metadata from the input object
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const text = await streamToString(obj.Body);
      const md = normalizeMeta(obj.Metadata || {});
      const voice = md.voice || "Joanna";
      const rate  = md.rate  || "medium";
      const pitch = md.pitch || "medium";

      // 2) Chunk text to safe sizes
      const chunks = chunkText(text, MAX_CHARS);

      // 3) Synthesize each chunk and upload to OUTPUT_BUCKET/audio/<base>/
      const baseName = key.split("/").pop().replace(/\.(txt|md)$/i, "");
      const outPrefix = `audio/${baseName}/`;

      const manifest = {
        source_bucket: bucket,
        source_key: key,
        voice, rate, pitch,
        engine: "auto",
        parts: []
      };

      let idx = 1;
      for (const chunk of chunks) {
        const { Text, TextType } = wrapSSML(chunk, rate, pitch);
        const audio = await synthesizeWithFallback({ Text, TextType, VoiceId: voice, OutputFormat: "mp3" });
        const buf = await streamToBuffer(audio.AudioStream);

        const partKey = `${outPrefix}${baseName}_${String(idx).padStart(3, "0")}.mp3`;
        await s3.send(new PutObjectCommand({
          Bucket: OUTPUT_BUCKET,
          Key: partKey,
          Body: buf,
          ContentType: "audio/mpeg",
          ContentLength: buf.length
        }));
        manifest.parts.push({ index: idx, key: partKey });
        idx++;
      }

      // 4) Write a manifest with all parts
      const manifestKey = `${outPrefix}${baseName}.manifest.json`;
      await s3.send(new PutObjectCommand({
        Bucket: OUTPUT_BUCKET,
        Key: manifestKey,
        Body: Buffer.from(JSON.stringify(manifest, null, 2)),
        ContentType: "application/json"
      }));

      console.log(`Converted ${key} -> ${manifest.parts.length} parts`);
    } catch (err) {
      console.error("Failed to process record:", err);
    }
  }
  return { ok: true };
};

// ---------- helpers ----------
function normalizeMeta(m){ const o={}; for(const [k,v] of Object.entries(m)) o[k.toLowerCase()]=v; return o; }

function chunkText(text, max){
  const parts=[], paras=text.split(/\n{2,}/); let buf="";
  const push=()=>{ if(buf.trim()) parts.push(buf.trim()); buf=""; };
  for(const para of paras){
    if((buf+"\n\n"+para).length<=max){ buf+=(buf?"\n\n":"")+para; }
    else{
      for(const s of para.split(/(?<=[.!?])\s+/)){
        if((buf+" "+s).length<=max){ buf+=(buf?" ":"")+s; }
        else{ push(); if(s.length>max){ for(let i=0;i<s.length;i+=max) parts.push(s.slice(i,i+max)); } else { buf=s; } }
      }
    }
    if(buf.length>=max-200) push();
  }
  push(); return parts.length?parts:[text.slice(0,max)];
}

function wrapSSML(text, rate, pitch){
  if (/<\s*speak[\s>]/i.test(text)) return { Text: text, TextType: "ssml" };
  const esc = s=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return { Text: `<speak><prosody rate="${rate}" pitch="${pitch}">${esc(text)}</prosody></speak>`, TextType: "ssml" };
}

async function synthesizeWithFallback(base){
  // Try Generative → Neural → Standard
  try { return await polly.send(new SynthesizeSpeechCommand({ ...base, Engine: "generative" })); }
  catch(e1){ console.warn("Generative not supported; trying Neural:", e1?.message||e1);
    try { return await polly.send(new SynthesizeSpeechCommand({ ...base, Engine: "neural" })); }
    catch(e2){ console.warn("Neural not supported; using Standard:", e2?.message||e2);
      return await polly.send(new SynthesizeSpeechCommand({ ...base, Engine: "standard" })); } }
}

async function streamToString(stream){ const a=[]; for await (const c of stream) a.push(c); return Buffer.concat(a).toString("utf-8"); }
async function streamToBuffer(stream){ const a=[]; for await (const c of stream) a.push(c); return Buffer.concat(a); }