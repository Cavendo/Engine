/**
 * S3-Compatible Storage Provider
 * Supports AWS S3, MinIO, Backblaze B2, and other S3-compatible services
 */

import { S3Client, PutObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createPinnedAgents, validateOutboundHttpUrl } from '../utils/outboundHttp.js';

/**
 * Create an S3 client from route config (per-call, no global state)
 * @param {Object} config - Storage config from route
 * @returns {S3Client}
 */
async function createClient(config) {
  const clientConfig = {
    region: config.region || 'us-east-1',
    credentials: {
      accessKeyId: config.access_key_id,
      secretAccessKey: config.secret_access_key
    }
  };

  // Custom endpoint for MinIO, Backblaze B2, etc.
  if (config.endpoint) {
    // Validate at connection time, then pin the SDK's socket lookup to the
    // resolved public IP. This protects route delivery against DNS rebinding
    // even if the endpoint was validated when it was saved.
    const endpointCheck = await validateOutboundHttpUrl(config.endpoint, {
      allowPrivate: false,
      requireHttpsInProduction: true
    });
    if (!endpointCheck.valid) {
      throw new Error(`Storage endpoint blocked: ${endpointCheck.reason}`);
    }
    const { httpAgent, httpsAgent } = createPinnedAgents(endpointCheck);
    clientConfig.endpoint = config.endpoint;
    clientConfig.forcePathStyle = true; // Required for MinIO
    clientConfig.requestHandler = new NodeHttpHandler({ httpAgent, httpsAgent });
  }

  return new S3Client(clientConfig);
}

/**
 * Upload a single object to S3
 * @param {Object} config - Storage config (bucket, region, endpoint, credentials)
 * @param {string} key - Full object key including any prefix (caller is responsible for prefixing)
 * @param {Buffer|string} body - File content
 * @param {string} contentType - MIME type
 * @returns {Promise<{key: string, bucket: string, size: number}>}
 */
export async function uploadToS3(config, key, body, contentType) {
  const client = await createClient(config);

  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: contentType
  });

  await client.send(command);

  const size = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.length;

  return { key, bucket: config.bucket, size };
}

/**
 * Test S3 connection by calling HeadBucket
 * @param {Object} config - Storage config
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function testS3Connection(config) {
  let client;
  try {
    client = await createClient(config);
  } catch (err) {
    return { success: false, message: err.message, detail: { code: 'ENDPOINT_BLOCKED', message: err.message } };
  }

  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return { success: true, message: `Connected to bucket "${config.bucket}" successfully` };
  } catch (err) {
    const detail = {
      code: err.name || err.Code,
      httpStatus: err.$metadata?.httpStatusCode,
      region: err.$metadata?.region,
      message: err.message
    };
    console.error('[S3Provider] Connection test failed:', JSON.stringify(detail));

    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return { success: false, message: `Bucket "${config.bucket}" not found`, detail };
    }
    if (err.name === 'Forbidden' || err.$metadata?.httpStatusCode === 403) {
      return { success: false, message: `Access denied — ${err.message}`, detail };
    }
    return { success: false, message: err.message || 'Unknown error connecting to S3', detail };
  }
}
