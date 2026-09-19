import { createHash, createHmac } from "crypto";
import sharp from "sharp";

/**
 * BytePlus ModelArk Private Asset Library (Private Virtual Portrait Library) API client.
 * Ref: Doc 2333565 (https://console.byteplus.com/ark/region:ap-southeast-1/docs/ModelArk/2333565)
 */

export const SUPPORTED_IMAGE_FORMATS = new Set([
  "jpeg",
  "jpg",
  "png",
  "webp",
  "bmp",
  "tiff",
  "gif",
  "heic",
  "heif",
]);

export const MIN_ASPECT_RATIO = 0.4;
export const MAX_ASPECT_RATIO = 2.5;
export const MIN_DIMENSION_PX = 300;
export const MAX_DIMENSION_PX = 6000;
export const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024; // 30 MB

export class BytePlusAssetError extends Error {
  code;
  status;
  details;
  constructor(message, code = "byteplus_asset_error", status = 400, details = null) {
    super(message);
    this.name = "BytePlusAssetError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function hmacSha256Hex(key, data) {
  return createHmac("sha256", key).update(data).digest("hex");
}

function rfc3986Encode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Signs a request using BytePlus/Volcengine OpenAPI Signature Version 4.
 */
export function signByteplusRequest({
  method = "POST",
  pathname = "/",
  query = {},
  headers = {},
  body = "",
  ak,
  sk,
  region = "ap-southeast-1",
  service = "ark",
  date = new Date(),
}) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = date.getUTCFullYear();
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());

  const xDate = `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
  const shortDate = `${yyyy}${mm}${dd}`;

  const payloadHash = sha256Hex(body);

  const reqHeaders = {
    ...headers,
    "x-date": xDate,
    "x-content-sha256": payloadHash,
  };

  const sortedHeaderKeys = Object.keys(reqHeaders)
    .map((k) => k.toLowerCase())
    .sort();

  let canonicalHeaders = "";
  for (const k of sortedHeaderKeys) {
    const val = String(reqHeaders[k] ?? "").trim();
    canonicalHeaders += `${k}:${val}\n`;
  }
  const signedHeaders = sortedHeaderKeys.join(";");

  const sortedQueryKeys = Object.keys(query).sort();
  const canonicalQueryString = sortedQueryKeys
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(String(query[k]))}`)
    .join("&");

  const canonicalUri = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = [
    "HMAC-SHA256",
    xDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(sk, shortDate);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "request");
  const signature = hmacSha256Hex(kSigning, stringToSign);

  const authHeader = `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    headers: {
      ...reqHeaders,
      Authorization: authHeader,
    },
    xDate,
    signedHeaders,
    signature,
    stringToSign,
  };
}

export function getByteplusConfig() {
  const ak = process.env.BYTEPLUS_ACCESS_KEY_ID || process.env.VOLCENGINE_ACCESS_KEY_ID;
  const sk = process.env.BYTEPLUS_SECRET_ACCESS_KEY || process.env.VOLCENGINE_SECRET_ACCESS_KEY;
  const apiKey = process.env.ARK_API_KEY;
  const region = process.env.BYTEPLUS_ARK_REGION || "ap-southeast-1";
  const host = process.env.BYTEPLUS_ARK_HOST || `ark.${region}.byteplusapi.com`;
  const baseUrl = process.env.BYTEPLUS_ARK_BASE_URL || `https://${host}`;

  const isMock =
    process.env.MOCK_ASSET_PROVIDER === "1" ||
    process.env.MOCK_GENERATION === "1" ||
    process.env.NODE_ENV === "test" ||
    (!ak || !sk);

  return { ak, sk, apiKey, region, host, baseUrl, isMock };
}

/**
 * In-memory simulated mock store for development and offline testing.
 */
const mockStore = {
  groups: new Map(),
  assets: new Map(),
};

export function resetMockStore() {
  mockStore.groups.clear();
  mockStore.assets.clear();
}

/**
 * Validates image dimensions, aspect ratio, format, and size according to BytePlus Doc 2333565.
 */
export async function validatePortraitImage(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new BytePlusAssetError("Image buffer is empty.", "invalid_image", 400);
  }
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new BytePlusAssetError(
      `Image size (${(buffer.length / (1024 * 1024)).toFixed(1)}MB) exceeds BytePlus 30MB limit.`,
      "file_too_large",
      400
    );
  }

  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch (err) {
    throw new BytePlusAssetError(
      `Could not decode image: ${err?.message || "unsupported format"}.`,
      "decode_failed",
      400
    );
  }

  const format = (metadata.format || "").toLowerCase();
  if (!SUPPORTED_IMAGE_FORMATS.has(format)) {
    throw new BytePlusAssetError(
      `Image format '${format}' is not supported by BytePlus. Accepted: ${Array.from(SUPPORTED_IMAGE_FORMATS).join(", ")}.`,
      "unsupported_format",
      400
    );
  }

  const width = metadata.width || 0;
  const height = metadata.height || 0;

  if (
    width < MIN_DIMENSION_PX ||
    width > MAX_DIMENSION_PX ||
    height < MIN_DIMENSION_PX ||
    height > MAX_DIMENSION_PX
  ) {
    throw new BytePlusAssetError(
      `Image resolution ${width}x${height} is out of bounds. BytePlus requires dimensions between ${MIN_DIMENSION_PX}px and ${MAX_DIMENSION_PX}px.`,
      "dimensions_out_of_bounds",
      400
    );
  }

  const ratio = width / height;
  if (ratio < MIN_ASPECT_RATIO || ratio > MAX_ASPECT_RATIO) {
    throw new BytePlusAssetError(
      `Image aspect ratio (${ratio.toFixed(2)}) is outside the required range (${MIN_ASPECT_RATIO} to ${MAX_ASPECT_RATIO}).`,
      "invalid_aspect_ratio",
      400
    );
  }

  return {
    format,
    width,
    height,
    ratio,
    sizeBytes: buffer.length,
  };
}

/**
 * Dispatches an action to BytePlus ModelArk OpenAPI or simulates via mock.
 */
export async function callByteplusAssetApi(action, body = {}, options = {}) {
  const config = getByteplusConfig();
  const fetchImpl = options.fetchImpl || fetch;

  if (config.isMock && !options.forceLive) {
    return handleMockAction(action, body);
  }

  const query = {
    Action: action,
    Version: "2024-01-01",
  };

  const bodyStr = JSON.stringify(body);
  let headers = {
    "content-type": "application/json",
    host: config.host,
  };

  if (config.ak && config.sk) {
    const signed = signByteplusRequest({
      method: "POST",
      pathname: "/",
      query,
      headers,
      body: bodyStr,
      ak: config.ak,
      sk: config.sk,
      region: config.region,
      service: "ark",
      date: new Date(),
    });
    headers = signed.headers;
  } else {
    // BytePlus OpenAPI strictly requires OpenAPI v4 signature with AK/SK.
    // Bearer tokens cause 400 InvalidAuthorization. Fall back safely to mock/local store.
    return handleMockAction(action, body);
  }

  const queryStr = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const url = `${config.baseUrl}/?${queryStr}`;

  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: options.signal,
    });
  } catch (err) {
    throw new BytePlusAssetError(
      `Network error contacting BytePlus Asset API: ${err?.message || err}`,
      "network_error",
      502
    );
  }

  const resText = await res.text();
  let json;
  try {
    json = JSON.parse(resText);
  } catch {
    throw new BytePlusAssetError(
      `BytePlus Asset API returned non-JSON response (${res.status}): ${resText.slice(0, 300)}`,
      "invalid_response",
      res.status
    );
  }

  if (!res.ok || json.ResponseMetadata?.Error) {
    const errInfo = json.ResponseMetadata?.Error || json.error || {};
    const errCode = errInfo.Code || errInfo.code || "unknown_error";
    const errMsg = errInfo.Message || errInfo.message || resText.slice(0, 300);

    if (/SensitiveContent|Privacy|real person|portrait/i.test(errCode + errMsg)) {
      throw new BytePlusAssetError(
        `Asset rejected by BytePlus compliance filter: ${errMsg}`,
        "moderation_rejected",
        res.status,
        json
      );
    }

    throw new BytePlusAssetError(
      `BytePlus Asset API error (${res.status} ${errCode}): ${errMsg}`,
      errCode,
      res.status,
      json
    );
  }

  return json.Result ?? json;
}

function handleMockAction(action, body) {
  const nowStr = new Date().toISOString();
  switch (action) {
    case "CreateAssetGroup": {
      const id = `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const group = {
        Id: id,
        Name: body.Name || "Untitled Group",
        Description: body.Description || "",
        GroupType: body.GroupType || "AIGC",
        ProjectName: body.ProjectName || "default",
        CreateTime: nowStr,
        UpdateTime: nowStr,
      };
      mockStore.groups.set(id, group);
      return { Id: id };
    }
    case "GetAssetGroup": {
      const group = mockStore.groups.get(body.GroupId || body.Id);
      if (!group) throw new BytePlusAssetError("Asset group not found.", "NotFound", 404);
      return group;
    }
    case "ListAssetGroups": {
      const items = Array.from(mockStore.groups.values());
      return { Items: items, NextToken: "" };
    }
    case "DeleteAssetGroup": {
      const id = body.GroupId || body.Id;
      mockStore.groups.delete(id);
      for (const [aid, asset] of mockStore.assets.entries()) {
        if (asset.GroupId === id) mockStore.assets.delete(aid);
      }
      return { Id: id };
    }
    case "CreateAsset": {
      const id = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const asset = {
        Id: id,
        GroupId: body.GroupId,
        Name: body.Name || "",
        AssetType: body.AssetType || "Image",
        URL: body.URL,
        Status: "Active", // Instantly active in mock
        ProjectName: body.ProjectName || "default",
        CreateTime: nowStr,
        UpdateTime: nowStr,
        LastInferenceTime: "",
      };
      mockStore.assets.set(id, asset);
      return { Id: id };
    }
    case "GetAsset": {
      const asset = mockStore.assets.get(body.Id || body.AssetId);
      if (!asset) throw new BytePlusAssetError("Asset not found.", "NotFound", 404);
      return asset;
    }
    case "ListAssets": {
      let items = Array.from(mockStore.assets.values());
      if (body.Filter?.GroupIds?.length) {
        const allowed = new Set(body.Filter.GroupIds);
        items = items.filter((a) => allowed.has(a.GroupId));
      }
      return { Items: items, NextToken: "" };
    }
    case "DeleteAsset": {
      const id = body.Id || body.AssetId;
      mockStore.assets.delete(id);
      return { Id: id };
    }
    default:
      throw new BytePlusAssetError(`Mock action '${action}' not implemented.`, "not_implemented", 400);
  }
}

// High-level client API methods
export const byteplusAssetClient = {
  createAssetGroup: (input, options) =>
    callByteplusAssetApi("CreateAssetGroup", {
      Name: input.name,
      Description: input.description || "",
      GroupType: input.groupType || "AIGC",
      ProjectName: input.projectName || "default",
    }, options),

  listAssetGroups: (input = {}, options) =>
    callByteplusAssetApi("ListAssetGroups", {
      Filter: {
        GroupType: input.groupType || "AIGC",
        ...(input.name ? { Name: input.name } : {}),
        ...(input.groupIds?.length ? { GroupIds: input.groupIds } : {}),
      },
      MaxResults: input.maxResults || 50,
      ...(input.nextToken ? { NextToken: input.nextToken } : {}),
      ProjectName: input.projectName || "default",
    }, options),

  getAssetGroup: (groupId, options) =>
    callByteplusAssetApi("GetAssetGroup", {
      Id: groupId,
      ProjectName: options?.projectName || "default",
    }, options),

  deleteAssetGroup: (groupId, options) =>
    callByteplusAssetApi("DeleteAssetGroup", {
      Id: groupId,
      ProjectName: options?.projectName || "default",
    }, options),

  createAsset: (input, options) =>
    callByteplusAssetApi("CreateAsset", {
      GroupId: input.groupId,
      URL: input.url,
      Name: input.name || "",
      AssetType: input.assetType || "Image",
      ProjectName: input.projectName || "default",
      Moderation: input.moderation || { Strategy: "Default" },
    }, options),

  getAsset: (assetId, options) =>
    callByteplusAssetApi("GetAsset", {
      Id: assetId,
      ProjectName: options?.projectName || "default",
    }, options),

  listAssets: (input = {}, options) =>
    callByteplusAssetApi("ListAssets", {
      Filter: {
        ...(input.groupIds?.length ? { GroupIds: input.groupIds } : {}),
        ...(input.statuses?.length ? { Statuses: input.statuses } : {}),
        GroupType: input.groupType || "AIGC",
      },
      MaxResults: input.maxResults || 50,
      ...(input.nextToken ? { NextToken: input.nextToken } : {}),
      ProjectName: input.projectName || "default",
    }, options),

  deleteAsset: (assetId, options) =>
    callByteplusAssetApi("DeleteAsset", {
      Id: assetId,
      ProjectName: options?.projectName || "default",
    }, options),
};
