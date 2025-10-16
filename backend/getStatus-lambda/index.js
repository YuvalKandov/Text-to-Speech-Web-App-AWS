//getStatus
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const REGION = process.env.AWS_REGION || "eu-central-1";
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;
const s3 = new S3Client({ region: REGION });

exports.handler = async (event) => {
  if (event?.requestContext?.http?.method === "OPTIONS") return cors(200, { ok: true });

  try {
    const q = event?.queryStringParameters || {};
    const key = q.key || "";
    const baseQ = (q.base || "").trim();
    const wantDebug = q.debug === "1";

    const baseFromKey = deriveBaseFromKey(key);      // e.g., "1760361890329-testTXT"
    const baseNoTs    = stripTimestamp(baseFromKey); // e.g., "testTXT"
    const basesToTry  = [baseQ || baseFromKey, baseNoTs].filter(Boolean);

    const tried = [];

    for (const base of basesToTry) {
      const prefix = `audio/${base}/`;
      const list = await s3.send(new ListObjectsV2Command({ Bucket: OUTPUT_BUCKET, Prefix: prefix }));
      const items = (list.Contents || []).map(o => o.Key);
      tried.push({ prefix, count: items.length });

      const mp3Keys = items.filter(k => k.endsWith(".mp3")).sort();
      const manifestKey = items.find(k => k.endsWith(".manifest.json")) || null;

      if (mp3Keys.length || manifestKey) {
        const mp3 = await Promise.all(mp3Keys.map(async k => ({
          key: k,
          url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: OUTPUT_BUCKET, Key: k }), { expiresIn: 3600 })
        })));
        const manifest = manifestKey
          ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: OUTPUT_BUCKET, Key: manifestKey }), { expiresIn: 3600 })
          : null;

        const payload = { ready: true, base, mp3, manifest, region: REGION };
        return cors(200, wantDebug ? { ...payload, debug: { tried } } : payload);
      }
    }

    return cors(200, wantDebug ? { ready: false, debug: { tried } } : { ready: false });

  } catch (err) {
    console.error(err);
    return cors(500, { message: "Status check failed", error: err.message });
  }
};

function deriveBaseFromKey(k){
  if (!k) return "";
  const name = k.split("/").pop() || "";
  return name.replace(/\.(txt|md)$/i, "");       // keep timestamp if present
}
function stripTimestamp(name){
  return (name || "").replace(/^\d+-/, "");      // optional alternate
}

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS"
    },
    body: JSON.stringify(body),
  };
}