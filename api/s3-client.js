// api/s3-client.js
'use strict'

const { S3Client } = require('@aws-sdk/client-s3')

const REGION = process.env.AWS_REGION || 'us-east-2'
const BUCKET = process.env.S3_MEDIA_BUCKET || 'sagerock-email-images'

const s3 = new S3Client({ region: REGION })

function publicUrlForKey(key) {
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`
}

module.exports = { s3, BUCKET, REGION, publicUrlForKey }
