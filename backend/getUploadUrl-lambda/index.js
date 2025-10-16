// getUploadUrl - returns a pre-signed PUT URL for uploading a .txt/.md (no required headers)
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const REGION = process.env.AWS_REGION || "eu-central-1";
const INPUT_BUCKET = process.env.INPUT_BUCKET;
const s3 = new S3Client({ region: REGION });

exports.handler = async (event) => {
  if (event?.requestContext?.http?.method === "OPTIONS") {
    return cors(200, { ok: true });
  }

  try {
    const body = event?.isBase64Encoded
      ? JSON.parse(Buffer.from(event.body, "base64").toString())
      : JSON.parse(event?.body || "{}");

    const filename = (body.filename || "").toString().trim();
    const voiceId = (body.voiceId || "Joanna").toString();
    const rate    = (body.rate || "medium").toString();
    const pitch   = (body.pitch || "medium").toString();

    if (!INPUT_BUCKET) return cors(500, { message: "INPUT_BUCKET not set" });
    if (!filename)     return cors(400, { message: "filename is required" });
    if (!/\.(txt|md)$/i.test(filename)) {
      return cors(400, { message: "Only .txt or .md are supported for now" });
    }

    const key = `incoming/${Date.now()}-${filename}`;

    // NOTE: no ContentType here; only metadata
    const cmd = new PutObjectCommand({
      Bucket: INPUT_BUCKET,
      Key: key,
      Metadata: { voice: voiceId, rate, pitch }
    });

    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 }); // 5 minutes

    return cors(200, { uploadUrl, key });
  } catch (err) {
    console.error(err);
    return cors(500, { message: "Failed to create upload URL", error: err.message });
  }
};

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