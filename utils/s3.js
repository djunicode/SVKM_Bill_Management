import { S3 } from "@aws-sdk/client-s3";

export const s3Upload = async (file, prefix = "uploads") => {
  const s3 = new S3({
    region: process.env.S3_REGION,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });

  if (!file) {
    throw new Error("No file provided");
  }

  const fileKey = `${prefix}/${Date.now()}-${file.originalname.replace(
    / /g,
    "-"
  )}`;

  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: fileKey,
    Body: file.buffer,
    ContentType: file.mimetype,
  };

  await s3.putObject(params);

  const publicUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.S3_REGION}.amazonaws.com/${fileKey}`;
  return {
    fileKey,
    fileName: file.originalname,
    url: publicUrl,
  };
};

/**
 * Normalize an S3 object key from a raw key or full S3/CloudFront URL.
 */
export const extractFileKeyFromUrl = (fileKeyOrUrl) => {
  if (!fileKeyOrUrl || typeof fileKeyOrUrl !== "string") {
    return null;
  }

  const trimmed = fileKeyOrUrl.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return trimmed.replace(/^\//, "");
  }

  try {
    const pathname = new URL(trimmed).pathname;
    return decodeURIComponent(pathname.replace(/^\//, ""));
  } catch {
    return trimmed;
  }
};

export const s3Delete = async (fileKey) => {
  const s3 = new S3({
    region: process.env.S3_REGION,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });

  if (!fileKey) {
    throw new Error("No file key provided");
  }

  const res = await s3
    .deleteObject({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: fileKey,
    })
    .catch((error) => {
      throw new Error(`Failed to delete file: ${error.message}`);
    });

  return {
    success: true,
    message: `File ${fileKey} deleted successfully`,
  };
};

/**
 * Fetch an object's bytes. Used by the forms repository (29.09, reply Q2) so a
 * download can be served with the form's original filename.
 */
export const s3Get = async (fileKey) => {
  const s3 = new S3({
    region: process.env.S3_REGION,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });

  if (!fileKey) {
    throw new Error("No file key provided");
  }

  const res = await s3.getObject({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: fileKey,
  });
  return Buffer.from(await res.Body.transformToByteArray());
};
