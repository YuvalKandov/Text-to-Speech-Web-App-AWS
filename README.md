# Text-to-Speech-Web-App-AWS
Serverless web application that converts text or uploaded documents into speech using Amazon Polly. Built with AWS Lambda, API Gateway, S3, and Amplify.

**Key AWS services**	
  •	Amazon Polly
	•	AWS Lambda (event-driven functions)
	•	Amazon S3 (input + output buckets)
	•	API Gateway (HTTP endpoints)
	•	AWS Amplify (frontend hosting)
	•	IAM (permissions & security)

  ## Project Diagram
  <img width="682" height="585" alt="Screenshot 2025-10-16 at 14 02 03" src="https://github.com/user-attachments/assets/d74a42fb-e7d8-43da-8555-b7480b15b57e" />


## Features
- 🔊 **Instant TTS**: POST `/tts` wraps text in SSML and calls Polly (Generative → Neural → Standard fallback).
- 📄 **Document upload**: POST `/upload-url` returns a **presigned S3 PUT** (no headers). Upload triggers conversion.
- ⚙️ **Controls**: Voice, rate, pitch via SSML prosody or S3 object metadata.
- 🔁 **Event-driven**: S3 **ObjectCreated** → Lambda converts → writes MP3 parts + manifest.
- 🔐 **Secure delivery**: **Signed** GET URLs (no public buckets).
- 🌐 **Static hosting**: Single-page site on AWS **Amplify**.

## Architecture
- **Frontend**: `frontend/index.html` (Amplify)
- **API Gateway**: HTTP API with routes:
  - `POST /tts` → **Lambda: tts**
  - `POST /upload-url` → **Lambda: getUploadUrl**
  - `GET /status` → **Lambda: getStatus**
- **S3 (input)**: `incoming/` — receives uploads via presigned PUT
- **S3 (output)**: `audio/<baseName>/` — MP3 parts + `<base>.manifest.json`
- **Lambda (docToSpeech)**: Triggered by S3 input → chunk, synthesize, and write outputs
- **Amazon Polly**: Engine fallback **generative → neural → standard**

## Repository structure

```
aws-text-to-speech-app/
│
├── backend/
│   ├── tts-lambda/
│   │   └── index.js
│   ├── getUploadUrl-lambda/
│   │   └── index.js
│   ├── docToSpeech-lambda/
│   │   └── index.js
│   ├── getStatus-lambda/
│   │   └── index.js
│   └── package.json
│
├── frontend/
│   └── index.html
│
├── architecture/
│   └── diagram.png
│
└── README.md
```

## Deploy (high-level)
1. **Buckets**
   - Input bucket (e.g., `polly-tts-input-p3`) — CORS allows `PUT,GET,HEAD` with `AllowedHeaders: ["*"]`.
   - Output bucket (e.g., `polly-audio-files-storage-p3`).

2. **Lambdas**
   - Runtime: **Node.js 20.x**, handler: `index.handler`, **CommonJS** (`index.js`, no `"type":"module"`).
   - Env vars:
     - `INPUT_BUCKET` (getUploadUrl only)
     - `OUTPUT_BUCKET` (tts, docToSpeech, getStatus)
   - IAM (least privilege):
     - `tts`: `polly:SynthesizeSpeech`, `s3:PutObject` to `outputBucket/audio/*`
     - `getUploadUrl`: (no S3 perms required to presign), or optionally restrict `s3:PutObject` to `inputBucket/incoming/*` if you validate server-side
     - `docToSpeech`: `s3:GetObject` on `inputBucket/incoming/*`, `s3:PutObject` on `outputBucket/audio/*`, `polly:SynthesizeSpeech`
     - `getStatus`: `s3:ListBucket` (prefix `audio/`) + `s3:GetObject` on `outputBucket/audio/*`

3. **S3 trigger**
   - Input bucket → Event notifications → **All object create**  
     Prefix: `incoming/` ; Suffix: `.txt` → Destination: **docToSpeech**.

4. **API Gateway routes**
   - `POST /tts` → **tts**
   - `POST /upload-url` → **getUploadUrl**
   - `GET /status` → **getStatus**
   - Enable CORS on the API.

5. **Amplify**
   - Host `frontend/index.html`.  

## Development Notes
This project helped me explore advanced AWS service integrations and fix real-world issues:
- Adjusted CORS and presigned URL logic for browser-based S3 uploads.
- Resolved Node.js runtime issues (CommonJS vs ES modules) in Lambda.
- Tuned Amazon Polly SSML for natural-sounding speech output.
