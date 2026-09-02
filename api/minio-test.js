// api/minio-test.js
// Read-only connection check for the MinIO bucket on the Synology NAS.
// Visit /api/minio-test in a browser. Returns JSON describing what happened.
// Never returns the secret key. Safe to leave in place, but it does reveal
// object names, so remove it once the migration is finished if you prefer.

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

export default async function handler(req, res) {
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

  if (missing.length) {
    return res.status(500).json({
      ok: false,
      step: 'environment-variables',
      error: 'Missing required environment variables in Vercel.',
      missing,
    });
  }

  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  });

  try {
    const out = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 20 })
    );

    const keys = (out.Contents || []).map((o) => ({
      key: o.Key,
      sizeBytes: o.Size,
    }));

    return res.status(200).json({
      ok: true,
      step: 'list-objects',
      message: 'Connected to MinIO and listed objects successfully.',
      endpoint,
      bucket,
      region,
      forcePathStyle,
      objectsShown: keys.length,
      truncated: Boolean(out.IsTruncated),
      sample: keys,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      step: 'list-objects',
      error: err && err.name ? err.name : 'UnknownError',
      message: err && err.message ? err.message : String(err),
      httpStatus:
        err && err.$metadata && err.$metadata.httpStatusCode
          ? err.$metadata.httpStatusCode
          : null,
      endpoint,
      bucket,
      region,
      forcePathStyle,
      hint:
        'AccessDenied or SignatureDoesNotMatch usually means the key/secret is wrong. ' +
        'NoSuchBucket means MINIO_BUCKET is wrong. A timeout or ECONNREFUSED usually ' +
        'means the Tailscale Funnel is not running on the NAS.',
    });
  }
}
