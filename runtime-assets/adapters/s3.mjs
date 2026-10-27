// Read-only S3 tools restricted to declared prefixes. IAM enforces the same
// scope; the checks here give the agent actionable errors.
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { ToolInputError, dispatch, loadConfig, optionalInteger, requireString } from './common.mjs';

const config = loadConfig();
const client = new S3Client({});

export function isAllowedKey(key, prefixes) {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

function looksLikeText(buffer, contentType) {
  if (
    contentType &&
    /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|csv))/.test(contentType)
  )
    return true;
  return !buffer.subarray(0, 8000).includes(0);
}

export const tools = {
  async list_objects(input) {
    const prefix =
      requireString(input, 'prefix', { optional: true }) ??
      (config.prefixes.length === 1 ? config.prefixes[0] : undefined);
    if (prefix === undefined) {
      throw new ToolInputError(
        `"prefix" is required. Allowed prefixes: ${config.prefixes.join(', ')}`,
      );
    }
    if (!isAllowedKey(prefix, config.prefixes)) {
      throw new ToolInputError(
        `Prefix "${prefix}" is outside the allowed prefixes: ${config.prefixes.join(', ')}`,
      );
    }
    const maxKeys = optionalInteger(input, 'maxKeys', {
      min: 1,
      max: config.maxKeys,
      fallback: config.maxKeys,
    });
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
        MaxKeys: maxKeys,
        ContinuationToken: requireString(input, 'nextToken', { optional: true, maxLength: 2048 }),
      }),
    );
    return {
      objects: (result.Contents ?? []).map((object) => ({
        key: object.Key,
        size: object.Size,
        lastModified: object.LastModified?.toISOString(),
      })),
      nextToken: result.IsTruncated ? result.NextContinuationToken : undefined,
    };
  },

  async get_object(input) {
    const key = requireString(input, 'key');
    if (!isAllowedKey(key, config.prefixes)) {
      throw new ToolInputError(
        `Key "${key}" is outside the allowed prefixes: ${config.prefixes.join(', ')}`,
      );
    }
    const maxBytes = optionalInteger(input, 'maxBytes', {
      min: 1,
      max: config.maxObjectBytes,
      fallback: config.maxObjectBytes,
    });
    const result = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key, Range: `bytes=0-${maxBytes - 1}` }),
    );
    const body = Buffer.from(await result.Body.transformToByteArray());
    const size = Number(result.ContentRange?.split('/')[1] ?? result.ContentLength ?? body.length);
    if (!looksLikeText(body, result.ContentType)) {
      return {
        key,
        size,
        contentType: result.ContentType,
        binary: true,
        text: undefined,
        truncated: size > body.length,
      };
    }
    return {
      key,
      size,
      contentType: result.ContentType,
      binary: false,
      text: body.toString('utf8'),
      truncated: size > body.length,
    };
  },
};

export const handler = (event, context) => dispatch(tools, event, context);
