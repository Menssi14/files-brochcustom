// api/minio-file.js
// Hands out short-lived, signed links so the browser can talk to MinIO directly
// without ever seeing the MinIO username or password.
//
// POST { action: "upload-url", key, contentType }  -> { ok, url, key, expiresIn }
// POST { action: "view-urls",  keys: [ ... ] }     -> { ok, urls: { key: url } }
// POST { action: "delete", key }                   -> { ok, key }
// POST { action: "list",    prefix }                -> { ok, files: [ {key,size,updated} ] }
//
// Uploads go browser -> MinIO directly, so Vercel's ~4.5MB request limit does
// not apply to the artwork itself.

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const UPLOAD_TTL = 900;    // 15 minutes to finish an upload
const VIEW_TTL = 21600;    // 6 hours for a viewable image link
const MAX_KEYS_PER_CALL = 500;

// Only these prefixes may be written to, so a stray call cannot overwrite
// settings files or other people's folders.
const ALLOWED_PREFIXES = ['_catalog/', '_designs/', '_fonts/', '_share/', '_store/', '_orders/'];

function badKey(key) {
  if (typeof key !== 'string' || !key.length || key.length > 512) return true;
  if (key.includes('..') || key.startsWith('/')) return true;
  return !ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

function makeClient() {
  const endpoint = process.env.MINIO_ENDPOINT;
  const accessKeyId = process.env.MINIO_ACCESS_KEY;
  const secretAccessKey = process.env.MINIO_SECRET_KEY;
  const bucket = process.env.MINIO_BUCKET;
  const region = process.env.MINIO_REGION || 'us-east-1';
  const forcePathStyle =
    String(process.env.MINIO_FORCE_PATH_STYLE || 'true').toLowerCase() !== 'false';

  const missing = [];
  if (!endpoint) missing.push('MINIO_ENDPOINT');
  if (!accessKeyId) missing.push('MINIO_ACCESS_KEY');
  if (!secretAccessKey) missing.push('MINIO_SECRET_KEY');
  if (!bucket) missing.push('MINIO_BUCKET');
  if (missing.length) return { missing };

  return {
    bucket,
    client: new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST.' });
  }

  const setup = makeClient();
  if (setup.missing) {
    return res.status(500).json({
      ok: false,
      step: 'environment-variables',
      error: 'Missing required environment variables in Vercel.',
      missing: setup.missing,
    });
  }
  const { client, bucket } = setup;

  let body;
  try {
    body = await readBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: 'Body was not valid JSON.' });
  }

  const action = body && body.action;

  try {
    if (action === 'upload-url') {
      const key = body.key;
      if (badKey(key)) {
        return res.status(400).json({ ok: false, error: 'Bad or disallowed key.', key });
      }
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: body.contentType || 'application/octet-stream',
        }),
        { expiresIn: UPLOAD_TTL }
      );
      return res.status(200).json({ ok: true, url, key, expiresIn: UPLOAD_TTL });
    }

    if (action === 'view-urls') {
      const keys = Array.isArray(body.keys) ? body.keys : [];
      if (!keys.length) {
        return res.status(400).json({ ok: false, error: 'No keys given.' });
      }
      if (keys.length > MAX_KEYS_PER_CALL) {
        return res.status(400).json({
          ok: false,
          error: 'Too many keys in one call.',
          max: MAX_KEYS_PER_CALL,
          got: keys.length,
        });
      }
      const urls = {};
      const skipped = [];
      await Promise.all(
        keys.map(async (key) => {
          if (badKey(key)) { skipped.push(key); return; }
          urls[key] = await getSignedUrl(
            client,
            new GetObjectCommand({ Bucket: bucket, Key: key }),
            { expiresIn: VIEW_TTL }
          );
        })
      );
      return res.status(200).json({ ok: true, urls, skipped, expiresIn: VIEW_TTL });
    }

    if (action === 'list') {
      const prefix = typeof body.prefix === 'string' ? body.prefix : '';
      if (!ALLOWED_PREFIXES.some((p) => p.startsWith(prefix) || prefix.startsWith(p))) {
        return res.status(400).json({ ok: false, error: 'Disallowed prefix.', prefix });
      }
      const files = [];
      let token;
      do {
        const out = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: 1000,
            ContinuationToken: token,
          })
        );
        (out.Contents || []).forEach((o) => {
          files.push({
            key: o.Key,
            size: o.Size,
            updated: o.LastModified ? new Date(o.LastModified).getTime() : 0,
          });
        });
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token && files.length < 5000);

      files.sort((a, b) => b.updated - a.updated);
      return res.status(200).json({ ok: true, prefix, files });
    }

    if (action === 'delete') {
      const key = body.key;
      if (badKey(key)) {
        return res.status(400).json({ ok: false, error: 'Bad or disallowed key.', key });
      }
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return res.status(200).json({ ok: true, key });
    }

    return res.status(400).json({
      ok: false,
      error: 'Unknown action.',
      allowed: ['upload-url', 'view-urls', 'list', 'delete'],
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      step: action || 'unknown',
      error: err && err.name ? err.name : 'UnknownError',
      message: err && err.message ? err.message : String(err),
    });
  }
}
