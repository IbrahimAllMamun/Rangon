import { loadEnv } from '../../src/config/env';
import { mediaUrl } from '../../src/common/media';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  cleanName,
  encodeKey,
  S3Client,
  S3Error,
  s3Key,
  s3ObjectUrl,
  type S3Settings,
  signRequest,
} from '../../src/common/s3';
import { DiskStorage, mediaStorage, S3MediaStorage } from '../../src/common/storage';

/**
 * What django-storages and botocore answer, printed in the Django container
 * (django-storages 1.14.4, boto3 1.35.81): `S3Storage(...).url(name)` with
 * this project's options, across endpoints, regions and bucket names, and
 * across keys; and the `Authorization` botocore's own `S3SigV4Auth` computes
 * for a request at a fixed moment.
 */
const URLS: [endpoint: string | null, region: string, bucket: string, url: string][] = [
  [
    null,
    'us-east-1',
    'rangon-media',
    'https://rangon-media.s3.amazonaws.com/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'us-east-1',
    'rangon.media',
    'https://s3.amazonaws.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'us-east-1',
    'rangon--media',
    'https://rangon--media.s3.amazonaws.com/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'us-east-1',
    '192.168.5.4',
    'https://s3.amazonaws.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'eu-west-1',
    'rangon-media',
    'https://rangon-media.s3.amazonaws.com/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'eu-west-1',
    'rangon.media',
    'https://s3.eu-west-1.amazonaws.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'eu-west-1',
    'rangon--media',
    'https://rangon--media.s3.amazonaws.com/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'eu-west-1',
    '192.168.5.4',
    'https://s3.eu-west-1.amazonaws.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'ap-southeast-1',
    'rangon-media',
    'https://rangon-media.s3.amazonaws.com/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'ap-southeast-1',
    'rangon.media',
    'https://s3.ap-southeast-1.amazonaws.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'ap-southeast-1',
    'rangon--media',
    'https://rangon--media.s3.amazonaws.com/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'ap-southeast-1',
    '192.168.5.4',
    'https://s3.ap-southeast-1.amazonaws.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'auto',
    'rangon-media',
    'https://rangon-media.s3.amazonaws.com/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'auto',
    'rangon.media',
    'https://s3.auto.amazonaws.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'auto',
    'rangon--media',
    'https://rangon--media.s3.amazonaws.com/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'auto',
    '192.168.5.4',
    'https://s3.auto.amazonaws.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'us-east-1',
    'rangon-media',
    'http://s3:7070/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'us-east-1',
    'rangon.media',
    'http://s3:7070/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'us-east-1',
    'rangon--media',
    'http://s3:7070/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'us-east-1',
    '192.168.5.4',
    'http://s3:7070/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'eu-west-1',
    'rangon-media',
    'http://s3:7070/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'eu-west-1',
    'rangon.media',
    'http://s3:7070/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'eu-west-1',
    'rangon--media',
    'http://s3:7070/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'eu-west-1',
    '192.168.5.4',
    'http://s3:7070/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'ap-southeast-1',
    'rangon-media',
    'http://s3:7070/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'ap-southeast-1',
    'rangon.media',
    'http://s3:7070/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'ap-southeast-1',
    'rangon--media',
    'http://s3:7070/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'ap-southeast-1',
    '192.168.5.4',
    'http://s3:7070/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'auto',
    'rangon-media',
    'http://s3:7070/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'auto',
    'rangon.media',
    'http://s3:7070/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'auto',
    'rangon--media',
    'http://s3:7070/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'auto',
    '192.168.5.4',
    'http://s3:7070/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'us-east-1',
    'rangon-media',
    'https://minio.example.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'us-east-1',
    'rangon.media',
    'https://minio.example.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'us-east-1',
    'rangon--media',
    'https://minio.example.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'us-east-1',
    '192.168.5.4',
    'https://minio.example.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'eu-west-1',
    'rangon-media',
    'https://minio.example.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'eu-west-1',
    'rangon.media',
    'https://minio.example.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'eu-west-1',
    'rangon--media',
    'https://minio.example.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'eu-west-1',
    '192.168.5.4',
    'https://minio.example.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'ap-southeast-1',
    'rangon-media',
    'https://minio.example.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'ap-southeast-1',
    'rangon.media',
    'https://minio.example.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'ap-southeast-1',
    'rangon--media',
    'https://minio.example.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'ap-southeast-1',
    '192.168.5.4',
    'https://minio.example.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'auto',
    'rangon-media',
    'https://minio.example.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'auto',
    'rangon.media',
    'https://minio.example.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'auto',
    'rangon--media',
    'https://minio.example.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'auto',
    '192.168.5.4',
    'https://minio.example.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'us-east-1',
    'rangon-media',
    'https://minio.example.com:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'us-east-1',
    'rangon.media',
    'https://minio.example.com:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'us-east-1',
    'rangon--media',
    'https://minio.example.com:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'us-east-1',
    '192.168.5.4',
    'https://minio.example.com:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'eu-west-1',
    'rangon-media',
    'https://minio.example.com:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'eu-west-1',
    'rangon.media',
    'https://minio.example.com:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'eu-west-1',
    'rangon--media',
    'https://minio.example.com:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'eu-west-1',
    '192.168.5.4',
    'https://minio.example.com:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'ap-southeast-1',
    'rangon-media',
    'https://minio.example.com:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'ap-southeast-1',
    'rangon.media',
    'https://minio.example.com:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'ap-southeast-1',
    'rangon--media',
    'https://minio.example.com:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'ap-southeast-1',
    '192.168.5.4',
    'https://minio.example.com:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'auto',
    'rangon-media',
    'https://minio.example.com:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'auto',
    'rangon.media',
    'https://minio.example.com:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'auto',
    'rangon--media',
    'https://minio.example.com:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'auto',
    '192.168.5.4',
    'https://minio.example.com:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'us-east-1',
    'rangon-media',
    'https://example.com/storage/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'us-east-1',
    'rangon.media',
    'https://example.com/storage/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'us-east-1',
    'rangon--media',
    'https://example.com/storage/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'us-east-1',
    '192.168.5.4',
    'https://example.com/storage/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'eu-west-1',
    'rangon-media',
    'https://example.com/storage/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'eu-west-1',
    'rangon.media',
    'https://example.com/storage/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'eu-west-1',
    'rangon--media',
    'https://example.com/storage/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'eu-west-1',
    '192.168.5.4',
    'https://example.com/storage/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'ap-southeast-1',
    'rangon-media',
    'https://example.com/storage/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'ap-southeast-1',
    'rangon.media',
    'https://example.com/storage/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'ap-southeast-1',
    'rangon--media',
    'https://example.com/storage/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'ap-southeast-1',
    '192.168.5.4',
    'https://example.com/storage/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'auto',
    'rangon-media',
    'https://example.com/storage/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'auto',
    'rangon.media',
    'https://example.com/storage/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'auto',
    'rangon--media',
    'https://example.com/storage/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'auto',
    '192.168.5.4',
    'https://example.com/storage/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'us-east-1',
    'rangon-media',
    'https://example.com/storage/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'us-east-1',
    'rangon.media',
    'https://example.com/storage/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'us-east-1',
    'rangon--media',
    'https://example.com/storage/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'us-east-1',
    '192.168.5.4',
    'https://example.com/storage/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'eu-west-1',
    'rangon-media',
    'https://example.com/storage/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'eu-west-1',
    'rangon.media',
    'https://example.com/storage/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'eu-west-1',
    'rangon--media',
    'https://example.com/storage/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'eu-west-1',
    '192.168.5.4',
    'https://example.com/storage/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'ap-southeast-1',
    'rangon-media',
    'https://example.com/storage/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'ap-southeast-1',
    'rangon.media',
    'https://example.com/storage/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'ap-southeast-1',
    'rangon--media',
    'https://example.com/storage/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'ap-southeast-1',
    '192.168.5.4',
    'https://example.com/storage/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'auto',
    'rangon-media',
    'https://example.com/storage/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'auto',
    'rangon.media',
    'https://example.com/storage/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'auto',
    'rangon--media',
    'https://example.com/storage/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'auto',
    '192.168.5.4',
    'https://example.com/storage/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'us-east-1',
    'rangon-media',
    'https://abc123.r2.cloudflarestorage.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'us-east-1',
    'rangon.media',
    'https://abc123.r2.cloudflarestorage.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'us-east-1',
    'rangon--media',
    'https://abc123.r2.cloudflarestorage.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'us-east-1',
    '192.168.5.4',
    'https://abc123.r2.cloudflarestorage.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'eu-west-1',
    'rangon-media',
    'https://abc123.r2.cloudflarestorage.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'eu-west-1',
    'rangon.media',
    'https://abc123.r2.cloudflarestorage.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'eu-west-1',
    'rangon--media',
    'https://abc123.r2.cloudflarestorage.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'eu-west-1',
    '192.168.5.4',
    'https://abc123.r2.cloudflarestorage.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'ap-southeast-1',
    'rangon-media',
    'https://abc123.r2.cloudflarestorage.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'ap-southeast-1',
    'rangon.media',
    'https://abc123.r2.cloudflarestorage.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'ap-southeast-1',
    'rangon--media',
    'https://abc123.r2.cloudflarestorage.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'ap-southeast-1',
    '192.168.5.4',
    'https://abc123.r2.cloudflarestorage.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'auto',
    'rangon-media',
    'https://abc123.r2.cloudflarestorage.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'auto',
    'rangon.media',
    'https://abc123.r2.cloudflarestorage.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'auto',
    'rangon--media',
    'https://abc123.r2.cloudflarestorage.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'auto',
    '192.168.5.4',
    'https://abc123.r2.cloudflarestorage.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'us-east-1',
    'rangon-media',
    'https://s3.eu-west-1.amazonaws.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'us-east-1',
    'rangon.media',
    'https://s3.eu-west-1.amazonaws.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'us-east-1',
    'rangon--media',
    'https://s3.eu-west-1.amazonaws.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'us-east-1',
    '192.168.5.4',
    'https://s3.eu-west-1.amazonaws.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'eu-west-1',
    'rangon-media',
    'https://s3.eu-west-1.amazonaws.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'eu-west-1',
    'rangon.media',
    'https://s3.eu-west-1.amazonaws.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'eu-west-1',
    'rangon--media',
    'https://s3.eu-west-1.amazonaws.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'eu-west-1',
    '192.168.5.4',
    'https://s3.eu-west-1.amazonaws.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'ap-southeast-1',
    'rangon-media',
    'https://s3.eu-west-1.amazonaws.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'ap-southeast-1',
    'rangon.media',
    'https://s3.eu-west-1.amazonaws.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'ap-southeast-1',
    'rangon--media',
    'https://s3.eu-west-1.amazonaws.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'ap-southeast-1',
    '192.168.5.4',
    'https://s3.eu-west-1.amazonaws.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'auto',
    'rangon-media',
    'https://s3.eu-west-1.amazonaws.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'auto',
    'rangon.media',
    'https://s3.eu-west-1.amazonaws.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'auto',
    'rangon--media',
    'https://s3.eu-west-1.amazonaws.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'auto',
    '192.168.5.4',
    'https://s3.eu-west-1.amazonaws.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'us-east-1',
    'rangon-media',
    'http://127.0.0.1:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'us-east-1',
    'rangon.media',
    'http://127.0.0.1:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'us-east-1',
    'rangon--media',
    'http://127.0.0.1:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'us-east-1',
    '192.168.5.4',
    'http://127.0.0.1:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'eu-west-1',
    'rangon-media',
    'http://127.0.0.1:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'eu-west-1',
    'rangon.media',
    'http://127.0.0.1:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'eu-west-1',
    'rangon--media',
    'http://127.0.0.1:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'eu-west-1',
    '192.168.5.4',
    'http://127.0.0.1:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'ap-southeast-1',
    'rangon-media',
    'http://127.0.0.1:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'ap-southeast-1',
    'rangon.media',
    'http://127.0.0.1:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'ap-southeast-1',
    'rangon--media',
    'http://127.0.0.1:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'ap-southeast-1',
    '192.168.5.4',
    'http://127.0.0.1:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'auto',
    'rangon-media',
    'http://127.0.0.1:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'auto',
    'rangon.media',
    'http://127.0.0.1:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'auto',
    'rangon--media',
    'http://127.0.0.1:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'auto',
    '192.168.5.4',
    'http://127.0.0.1:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'us-east-1',
    'rangon-media',
    'https://nyc3.digitaloceanspaces.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'us-east-1',
    'rangon.media',
    'https://nyc3.digitaloceanspaces.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'us-east-1',
    'rangon--media',
    'https://nyc3.digitaloceanspaces.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'us-east-1',
    '192.168.5.4',
    'https://nyc3.digitaloceanspaces.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'eu-west-1',
    'rangon-media',
    'https://nyc3.digitaloceanspaces.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'eu-west-1',
    'rangon.media',
    'https://nyc3.digitaloceanspaces.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'eu-west-1',
    'rangon--media',
    'https://nyc3.digitaloceanspaces.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'eu-west-1',
    '192.168.5.4',
    'https://nyc3.digitaloceanspaces.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'ap-southeast-1',
    'rangon-media',
    'https://nyc3.digitaloceanspaces.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'ap-southeast-1',
    'rangon.media',
    'https://nyc3.digitaloceanspaces.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'ap-southeast-1',
    'rangon--media',
    'https://nyc3.digitaloceanspaces.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'ap-southeast-1',
    '192.168.5.4',
    'https://nyc3.digitaloceanspaces.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'auto',
    'rangon-media',
    'https://nyc3.digitaloceanspaces.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'auto',
    'rangon.media',
    'https://nyc3.digitaloceanspaces.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'auto',
    'rangon--media',
    'https://nyc3.digitaloceanspaces.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'auto',
    '192.168.5.4',
    'https://nyc3.digitaloceanspaces.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'us-east-1',
    'rangon-media',
    'http://localhost:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'us-east-1',
    'rangon.media',
    'http://localhost:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'us-east-1',
    'rangon--media',
    'http://localhost:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'us-east-1',
    '192.168.5.4',
    'http://localhost:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'eu-west-1',
    'rangon-media',
    'http://localhost:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'eu-west-1',
    'rangon.media',
    'http://localhost:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'eu-west-1',
    'rangon--media',
    'http://localhost:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'eu-west-1',
    '192.168.5.4',
    'http://localhost:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'ap-southeast-1',
    'rangon-media',
    'http://localhost:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'ap-southeast-1',
    'rangon.media',
    'http://localhost:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'ap-southeast-1',
    'rangon--media',
    'http://localhost:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'ap-southeast-1',
    '192.168.5.4',
    'http://localhost:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'auto',
    'rangon-media',
    'http://localhost:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'auto',
    'rangon.media',
    'http://localhost:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'auto',
    'rangon--media',
    'http://localhost:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'auto',
    '192.168.5.4',
    'http://localhost:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'us-east-1',
    'rangon-media',
    'https://s3.amazonaws.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'us-east-1',
    'rangon.media',
    'https://s3.amazonaws.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'us-east-1',
    'rangon--media',
    'https://s3.amazonaws.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'us-east-1',
    '192.168.5.4',
    'https://s3.amazonaws.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'eu-west-1',
    'rangon-media',
    'https://s3.amazonaws.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'eu-west-1',
    'rangon.media',
    'https://s3.amazonaws.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'eu-west-1',
    'rangon--media',
    'https://s3.amazonaws.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'eu-west-1',
    '192.168.5.4',
    'https://s3.amazonaws.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'ap-southeast-1',
    'rangon-media',
    'https://s3.amazonaws.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'ap-southeast-1',
    'rangon.media',
    'https://s3.amazonaws.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'ap-southeast-1',
    'rangon--media',
    'https://s3.amazonaws.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'ap-southeast-1',
    '192.168.5.4',
    'https://s3.amazonaws.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'auto',
    'rangon-media',
    'https://s3.amazonaws.com/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'auto',
    'rangon.media',
    'https://s3.amazonaws.com/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'auto',
    'rangon--media',
    'https://s3.amazonaws.com/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'auto',
    '192.168.5.4',
    'https://s3.amazonaws.com/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'us-east-1',
    'rangon-media',
    'http://[::1]:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'us-east-1',
    'rangon.media',
    'http://[::1]:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'us-east-1',
    'rangon--media',
    'http://[::1]:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'us-east-1',
    '192.168.5.4',
    'http://[::1]:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'eu-west-1',
    'rangon-media',
    'http://[::1]:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'eu-west-1',
    'rangon.media',
    'http://[::1]:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'eu-west-1',
    'rangon--media',
    'http://[::1]:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'eu-west-1',
    '192.168.5.4',
    'http://[::1]:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'ap-southeast-1',
    'rangon-media',
    'http://[::1]:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'ap-southeast-1',
    'rangon.media',
    'http://[::1]:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'ap-southeast-1',
    'rangon--media',
    'http://[::1]:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'ap-southeast-1',
    '192.168.5.4',
    'http://[::1]:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'auto',
    'rangon-media',
    'http://[::1]:9000/rangon-media/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'auto',
    'rangon.media',
    'http://[::1]:9000/rangon.media/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'auto',
    'rangon--media',
    'http://[::1]:9000/rangon--media/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'auto',
    '192.168.5.4',
    'http://[::1]:9000/192.168.5.4/products/2026/10/shirt.jpg',
  ],
];

/** The same, for names S3 itself would refuse: capitals, an underscore, too short, too long. */
const IMPOSSIBLE: [endpoint: string | null, region: string, bucket: string, url: string][] = [
  [
    null,
    'us-east-1',
    'Rangon_Media',
    'https://s3.amazonaws.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [null, 'us-east-1', 'rg', 'https://s3.amazonaws.com/rg/products/2026/10/shirt.jpg'],
  [
    null,
    'us-east-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://s3.amazonaws.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'eu-west-1',
    'Rangon_Media',
    'https://s3.eu-west-1.amazonaws.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [null, 'eu-west-1', 'rg', 'https://s3.amazonaws.com/rg/products/2026/10/shirt.jpg'],
  [
    null,
    'eu-west-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://s3.eu-west-1.amazonaws.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'ap-southeast-1',
    'Rangon_Media',
    'https://s3.ap-southeast-1.amazonaws.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [null, 'ap-southeast-1', 'rg', 'https://s3.amazonaws.com/rg/products/2026/10/shirt.jpg'],
  [
    null,
    'ap-southeast-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://s3.ap-southeast-1.amazonaws.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    null,
    'auto',
    'Rangon_Media',
    'https://s3.auto.amazonaws.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [null, 'auto', 'rg', 'https://s3.amazonaws.com/rg/products/2026/10/shirt.jpg'],
  [
    null,
    'auto',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://s3.auto.amazonaws.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'us-east-1',
    'Rangon_Media',
    'http://s3:7070/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  ['http://s3:7070', 'us-east-1', 'rg', 'http://s3:7070/rg/products/2026/10/shirt.jpg'],
  [
    'http://s3:7070',
    'us-east-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://s3:7070/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'eu-west-1',
    'Rangon_Media',
    'http://s3:7070/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  ['http://s3:7070', 'eu-west-1', 'rg', 'http://s3:7070/rg/products/2026/10/shirt.jpg'],
  [
    'http://s3:7070',
    'eu-west-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://s3:7070/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'ap-southeast-1',
    'Rangon_Media',
    'http://s3:7070/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  ['http://s3:7070', 'ap-southeast-1', 'rg', 'http://s3:7070/rg/products/2026/10/shirt.jpg'],
  [
    'http://s3:7070',
    'ap-southeast-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://s3:7070/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://s3:7070',
    'auto',
    'Rangon_Media',
    'http://s3:7070/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  ['http://s3:7070', 'auto', 'rg', 'http://s3:7070/rg/products/2026/10/shirt.jpg'],
  [
    'http://s3:7070',
    'auto',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://s3:7070/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'us-east-1',
    'Rangon_Media',
    'https://minio.example.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'us-east-1',
    'rg',
    'https://minio.example.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'us-east-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://minio.example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'eu-west-1',
    'Rangon_Media',
    'https://minio.example.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'eu-west-1',
    'rg',
    'https://minio.example.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'eu-west-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://minio.example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'ap-southeast-1',
    'Rangon_Media',
    'https://minio.example.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'ap-southeast-1',
    'rg',
    'https://minio.example.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'ap-southeast-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://minio.example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'auto',
    'Rangon_Media',
    'https://minio.example.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'auto',
    'rg',
    'https://minio.example.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com',
    'auto',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://minio.example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'us-east-1',
    'Rangon_Media',
    'https://minio.example.com:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'us-east-1',
    'rg',
    'https://minio.example.com:9000/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'us-east-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://minio.example.com:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'eu-west-1',
    'Rangon_Media',
    'https://minio.example.com:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'eu-west-1',
    'rg',
    'https://minio.example.com:9000/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'eu-west-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://minio.example.com:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'ap-southeast-1',
    'Rangon_Media',
    'https://minio.example.com:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'ap-southeast-1',
    'rg',
    'https://minio.example.com:9000/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'ap-southeast-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://minio.example.com:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'auto',
    'Rangon_Media',
    'https://minio.example.com:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'auto',
    'rg',
    'https://minio.example.com:9000/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://minio.example.com:9000/',
    'auto',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://minio.example.com:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'us-east-1',
    'Rangon_Media',
    'https://example.com/storage/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'us-east-1',
    'rg',
    'https://example.com/storage/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'us-east-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://example.com/storage/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'eu-west-1',
    'Rangon_Media',
    'https://example.com/storage/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'eu-west-1',
    'rg',
    'https://example.com/storage/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'eu-west-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://example.com/storage/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'ap-southeast-1',
    'Rangon_Media',
    'https://example.com/storage/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'ap-southeast-1',
    'rg',
    'https://example.com/storage/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'ap-southeast-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://example.com/storage/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'auto',
    'Rangon_Media',
    'https://example.com/storage/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'auto',
    'rg',
    'https://example.com/storage/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage',
    'auto',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://example.com/storage/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'us-east-1',
    'Rangon_Media',
    'https://example.com/storage/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'us-east-1',
    'rg',
    'https://example.com/storage/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'us-east-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://example.com/storage/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'eu-west-1',
    'Rangon_Media',
    'https://example.com/storage/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'eu-west-1',
    'rg',
    'https://example.com/storage/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'eu-west-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://example.com/storage/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'ap-southeast-1',
    'Rangon_Media',
    'https://example.com/storage/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'ap-southeast-1',
    'rg',
    'https://example.com/storage/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'ap-southeast-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://example.com/storage/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'auto',
    'Rangon_Media',
    'https://example.com/storage/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'auto',
    'rg',
    'https://example.com/storage/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://example.com/storage/',
    'auto',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://example.com/storage/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'us-east-1',
    'Rangon_Media',
    'https://abc123.r2.cloudflarestorage.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'us-east-1',
    'rg',
    'https://abc123.r2.cloudflarestorage.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'us-east-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://abc123.r2.cloudflarestorage.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'eu-west-1',
    'Rangon_Media',
    'https://abc123.r2.cloudflarestorage.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'eu-west-1',
    'rg',
    'https://abc123.r2.cloudflarestorage.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'eu-west-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://abc123.r2.cloudflarestorage.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'ap-southeast-1',
    'Rangon_Media',
    'https://abc123.r2.cloudflarestorage.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'ap-southeast-1',
    'rg',
    'https://abc123.r2.cloudflarestorage.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'ap-southeast-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://abc123.r2.cloudflarestorage.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'auto',
    'Rangon_Media',
    'https://abc123.r2.cloudflarestorage.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'auto',
    'rg',
    'https://abc123.r2.cloudflarestorage.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://abc123.r2.cloudflarestorage.com',
    'auto',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://abc123.r2.cloudflarestorage.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'us-east-1',
    'Rangon_Media',
    'https://s3.eu-west-1.amazonaws.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'us-east-1',
    'rg',
    'https://s3.eu-west-1.amazonaws.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'us-east-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://s3.eu-west-1.amazonaws.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'eu-west-1',
    'Rangon_Media',
    'https://s3.eu-west-1.amazonaws.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'eu-west-1',
    'rg',
    'https://s3.eu-west-1.amazonaws.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'eu-west-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://s3.eu-west-1.amazonaws.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'ap-southeast-1',
    'Rangon_Media',
    'https://s3.eu-west-1.amazonaws.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'ap-southeast-1',
    'rg',
    'https://s3.eu-west-1.amazonaws.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'ap-southeast-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://s3.eu-west-1.amazonaws.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'auto',
    'Rangon_Media',
    'https://s3.eu-west-1.amazonaws.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'auto',
    'rg',
    'https://s3.eu-west-1.amazonaws.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.eu-west-1.amazonaws.com',
    'auto',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://s3.eu-west-1.amazonaws.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'us-east-1',
    'Rangon_Media',
    'http://127.0.0.1:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'us-east-1',
    'rg',
    'http://127.0.0.1:9000/rg/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'us-east-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://127.0.0.1:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'eu-west-1',
    'Rangon_Media',
    'http://127.0.0.1:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'eu-west-1',
    'rg',
    'http://127.0.0.1:9000/rg/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'eu-west-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://127.0.0.1:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'ap-southeast-1',
    'Rangon_Media',
    'http://127.0.0.1:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'ap-southeast-1',
    'rg',
    'http://127.0.0.1:9000/rg/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'ap-southeast-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://127.0.0.1:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://127.0.0.1:9000',
    'auto',
    'Rangon_Media',
    'http://127.0.0.1:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  ['http://127.0.0.1:9000', 'auto', 'rg', 'http://127.0.0.1:9000/rg/products/2026/10/shirt.jpg'],
  [
    'http://127.0.0.1:9000',
    'auto',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://127.0.0.1:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'us-east-1',
    'Rangon_Media',
    'https://nyc3.digitaloceanspaces.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'us-east-1',
    'rg',
    'https://nyc3.digitaloceanspaces.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'us-east-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://nyc3.digitaloceanspaces.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'eu-west-1',
    'Rangon_Media',
    'https://nyc3.digitaloceanspaces.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'eu-west-1',
    'rg',
    'https://nyc3.digitaloceanspaces.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'eu-west-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://nyc3.digitaloceanspaces.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'ap-southeast-1',
    'Rangon_Media',
    'https://nyc3.digitaloceanspaces.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'ap-southeast-1',
    'rg',
    'https://nyc3.digitaloceanspaces.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'ap-southeast-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://nyc3.digitaloceanspaces.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'auto',
    'Rangon_Media',
    'https://nyc3.digitaloceanspaces.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'auto',
    'rg',
    'https://nyc3.digitaloceanspaces.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://nyc3.digitaloceanspaces.com',
    'auto',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://nyc3.digitaloceanspaces.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'us-east-1',
    'Rangon_Media',
    'http://localhost:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'us-east-1',
    'rg',
    'http://localhost:9000/rg/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'us-east-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://localhost:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'eu-west-1',
    'Rangon_Media',
    'http://localhost:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'eu-west-1',
    'rg',
    'http://localhost:9000/rg/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'eu-west-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://localhost:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'ap-southeast-1',
    'Rangon_Media',
    'http://localhost:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'ap-southeast-1',
    'rg',
    'http://localhost:9000/rg/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'ap-southeast-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://localhost:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://localhost:9000',
    'auto',
    'Rangon_Media',
    'http://localhost:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  ['http://localhost:9000', 'auto', 'rg', 'http://localhost:9000/rg/products/2026/10/shirt.jpg'],
  [
    'http://localhost:9000',
    'auto',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://localhost:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'us-east-1',
    'Rangon_Media',
    'https://s3.amazonaws.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'us-east-1',
    'rg',
    'https://s3.amazonaws.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'us-east-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://s3.amazonaws.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'eu-west-1',
    'Rangon_Media',
    'https://s3.amazonaws.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'eu-west-1',
    'rg',
    'https://s3.amazonaws.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'eu-west-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://s3.amazonaws.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'ap-southeast-1',
    'Rangon_Media',
    'https://s3.amazonaws.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'ap-southeast-1',
    'rg',
    'https://s3.amazonaws.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'ap-southeast-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://s3.amazonaws.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'auto',
    'Rangon_Media',
    'https://s3.amazonaws.com/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'auto',
    'rg',
    'https://s3.amazonaws.com/rg/products/2026/10/shirt.jpg',
  ],
  [
    'https://s3.amazonaws.com',
    'auto',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'https://s3.amazonaws.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'us-east-1',
    'Rangon_Media',
    'http://[::1]:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  ['http://[::1]:9000', 'us-east-1', 'rg', 'http://[::1]:9000/rg/products/2026/10/shirt.jpg'],
  [
    'http://[::1]:9000',
    'us-east-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://[::1]:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'eu-west-1',
    'Rangon_Media',
    'http://[::1]:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  ['http://[::1]:9000', 'eu-west-1', 'rg', 'http://[::1]:9000/rg/products/2026/10/shirt.jpg'],
  [
    'http://[::1]:9000',
    'eu-west-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://[::1]:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'ap-southeast-1',
    'Rangon_Media',
    'http://[::1]:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  ['http://[::1]:9000', 'ap-southeast-1', 'rg', 'http://[::1]:9000/rg/products/2026/10/shirt.jpg'],
  [
    'http://[::1]:9000',
    'ap-southeast-1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://[::1]:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
  [
    'http://[::1]:9000',
    'auto',
    'Rangon_Media',
    'http://[::1]:9000/Rangon_Media/products/2026/10/shirt.jpg',
  ],
  ['http://[::1]:9000', 'auto', 'rg', 'http://[::1]:9000/rg/products/2026/10/shirt.jpg'],
  [
    'http://[::1]:9000',
    'auto',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'http://[::1]:9000/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/products/2026/10/shirt.jpg',
  ],
];

const KEYS: [name: string, url: string][] = [
  ['a.png', 'http://s3:7070/rangon-parity/a.png'],
  ['a b.png', 'http://s3:7070/rangon-parity/a%20b.png'],
  ['a+b.png', 'http://s3:7070/rangon-parity/a%2Bb.png'],
  ['a&b=c.png', 'http://s3:7070/rangon-parity/a%26b%3Dc.png'],
  ['ছবি.png', 'http://s3:7070/rangon-parity/%E0%A6%9B%E0%A6%AC%E0%A6%BF.png'],
  ['a%b.png', 'http://s3:7070/rangon-parity/a%25b.png'],
  ['a/b/c.png', 'http://s3:7070/rangon-parity/a/b/c.png'],
  ['a//b.png', 'http://s3:7070/rangon-parity/a/b.png'],
  ['/lead.png', 'http://s3:7070/rangon-parity/lead.png'],
  ['a/../b.png', 'http://s3:7070/rangon-parity/b.png'],
  ['./a.png', 'http://s3:7070/rangon-parity/a.png'],
  ['a\\b.png', 'http://s3:7070/rangon-parity/a/b.png'],
  ['a?b#c.png', 'http://s3:7070/rangon-parity/a%3Fb%23c.png'],
  ["a~b!c*d(e)f'g.png", 'http://s3:7070/rangon-parity/a~b%21c%2Ad%28e%29f%27g.png'],
  ['a:b@c.png', 'http://s3:7070/rangon-parity/a%3Ab%40c.png'],
  ['a,b;c.png', 'http://s3:7070/rangon-parity/a%2Cb%3Bc.png'],
  ['a$b.png', 'http://s3:7070/rangon-parity/a%24b.png'],
  ['tr ail/', 'http://s3:7070/rangon-parity/tr%20ail/'],
  ['a/./b.png', 'http://s3:7070/rangon-parity/a/b.png'],
  ['üñí.png', 'http://s3:7070/rangon-parity/%C3%BC%C3%B1%C3%AD.png'],
  ['a"b<c>.png', 'http://s3:7070/rangon-parity/a%22b%3Cc%3E.png'],
  ['a|b^c`d{e}.png', 'http://s3:7070/rangon-parity/a%7Cb%5Ec%60d%7Be%7D.png'],
  ['a[b].png', 'http://s3:7070/rangon-parity/a%5Bb%5D.png'],
  [' lead.png', 'http://s3:7070/rangon-parity/%20lead.png'],
  ['100%25.png', 'http://s3:7070/rangon-parity/100%2525.png'],
  ['é/è.png', 'http://s3:7070/rangon-parity/%C3%A9/%C3%A8.png'],
  ['😀.png', 'http://s3:7070/rangon-parity/%F0%9F%98%80.png'],
];

const SIGNED: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  authorization: string;
  date: string;
  sha: string;
}[] = [
  {
    method: 'GET',
    url: 'http://s3:7070/rangon-parity/products/2026/10/shirt.jpg',
    headers: {},
    body: '',
    region: 'us-east-1',
    authorization:
      'AWS4-HMAC-SHA256 Credential=parity-s3-key/20261008/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=ce72931cc12a4ca98f108fd9a0ae8fa31f511d1603a7176211655ddc80506a94',
    date: '20261008T123456Z',
    sha: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    method: 'HEAD',
    url: 'http://s3:7070/rangon-parity/products/2026/10/a%20b.png',
    headers: {},
    body: '',
    region: 'us-east-1',
    authorization:
      'AWS4-HMAC-SHA256 Credential=parity-s3-key/20261008/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=5c5ddcf86f21e89fc2449c4bf08b85be093029f52e5e3d3d2457e1e42855994d',
    date: '20261008T123456Z',
    sha: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    method: 'PUT',
    url: 'http://s3:7070/rangon-parity/expenses/2026/10/abc.pdf',
    headers: {
      'content-type': 'application/pdf',
    },
    body: '255044462d312e342072656365697074',
    region: 'us-east-1',
    authorization:
      'AWS4-HMAC-SHA256 Credential=parity-s3-key/20261008/us-east-1/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=492772669ae365b78a85742bc2dcc5f093f053c71b8d226d42c2aedd79004676',
    date: '20261008T123456Z',
    sha: '1cfd9c781ea8b21c3c17bb558def1d77998c237072a86ec620a1121ea4fc2a1d',
  },
  {
    method: 'PUT',
    url: 'http://s3:7070/rangon-parity/x/%E0%A6%9B%E0%A6%AC%E0%A6%BF.png.gz',
    headers: {
      'content-type': 'image/png',
      'content-encoding': 'gzip',
    },
    body: '1f8b206279746573',
    region: 'eu-west-1',
    authorization:
      'AWS4-HMAC-SHA256 Credential=parity-s3-key/20261008/eu-west-1/s3/aws4_request, SignedHeaders=content-encoding;content-type;host;x-amz-content-sha256;x-amz-date, Signature=b0581bbabd334e91247a7bcf105ce6d10cea7dc0de6ec44753e4d9d046a6d007',
    date: '20261008T123456Z',
    sha: '37bc544c149e240aee7026d3de4ec2c77c0aa1a52fef2a90d8c1f71900506b04',
  },
  {
    method: 'DELETE',
    url: 'https://rangon-media.s3.eu-west-1.amazonaws.com/a%2Bb~c%21.png',
    headers: {},
    body: '',
    region: 'eu-west-1',
    authorization:
      'AWS4-HMAC-SHA256 Credential=parity-s3-key/20261008/eu-west-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=3ebe93559fa1b9a971d30b8b8b30368f24e76463e3c14cf51e39a5460859cd62',
    date: '20261008T123456Z',
    sha: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    method: 'GET',
    url: 'https://s3.ap-southeast-1.amazonaws.com/Rangon_Media/a/b/c.png',
    headers: {},
    body: '',
    region: 'ap-southeast-1',
    authorization:
      'AWS4-HMAC-SHA256 Credential=parity-s3-key/20261008/ap-southeast-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=b957303b13acc7e36a1d8e69c9bb0f640c38d25e562aced2c5894cc32ebf0646',
    date: '20261008T123456Z',
    sha: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  {
    method: 'PUT',
    url: 'https://minio.example.com:9000/bucket/a.txt',
    headers: {
      'content-type': 'text/plain;  charset=utf-8',
    },
    body: 'e0a6ace0a6bee0a682e0a6b2e0a6be',
    region: 'auto',
    authorization:
      'AWS4-HMAC-SHA256 Credential=parity-s3-key/20261008/auto/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=1a13d4f1b9fcbccde8d73a80c730c9179c6528694f8e24ee40d293730edd1119',
    date: '20261008T123456Z',
    sha: '3bdfce0a268d154828af6e9f5e4b9962d0ee04a148ca64d8994570eed9556afd',
  },
];

const settings = (endpoint: string | null, region: string, bucket: string): S3Settings => ({
  endpoint,
  region,
  bucket,
  accessKey: 'k',
  secretKey: 's',
});

describe("an object's URL, against S3Storage.url", () => {
  it.each(URLS)('endpoint %j, region %s, bucket %s', (endpoint, region, bucket, url) => {
    expect(s3ObjectUrl(settings(endpoint, region, bucket), 'products/2026/10/shirt.jpg')).toBe(url);
  });

  it('addresses a bucket no S3 has the same way too, but for one name botocore sends elsewhere', () => {
    // Not a rule worth copying: a two-letter name cannot be a bucket, and
    // botocore sends it to the global endpoint from any region. Everything
    // else it prints for an impossible name, this prints too.
    const differing = IMPOSSIBLE.filter(
      ([endpoint, region, bucket, url]) =>
        s3ObjectUrl(settings(endpoint, region, bucket), 'products/2026/10/shirt.jpg') !== url,
    );
    expect(differing.map(([endpoint, region, bucket]) => [endpoint, region, bucket])).toEqual([
      [null, 'eu-west-1', 'rg'],
      [null, 'ap-southeast-1', 'rg'],
      [null, 'auto', 'rg'],
    ]);
  });

  it.each(KEYS)('the name %j', (name, url) => {
    expect(s3ObjectUrl(settings('http://s3:7070', 'us-east-1', 'rangon-parity'), name)).toBe(url);
  });

  it('is what a payload carries when uploads are in a bucket, and passed through unchanged', () => {
    const bucket = settings('https://minio.example.com', 'us-east-1', 'rangon-media');
    expect(mediaUrl('products/x y.jpg', bucket)).toBe(
      'https://minio.example.com/rangon-media/products/x%20y.jpg',
    );
    expect(mediaUrl('', bucket)).toBe('');
    expect(mediaUrl(null, bucket)).toBe('');
    // On disk it is root-relative, as before.
    expect(mediaUrl('products/x y.jpg', '/media/')).toBe('/media/products/x%20y.jpg');
  });
});

describe("an object's key", () => {
  it("is the name cleaned and resolved under the bucket's top", () => {
    expect(s3Key('products/2026/10/a.png')).toBe('products/2026/10/a.png');
    expect(s3Key('/lead.png')).toBe('lead.png');
    expect(s3Key('a/../../b.png')).toBe('b.png');
    expect(s3Key('a\\b.png')).toBe('a/b.png');
    expect(s3Key('tr ail/')).toBe('tr ail/');
    expect(s3Key('')).toBe('');
    expect(cleanName('a//b/./c.png')).toBe('a/b/c.png');
    expect(cleanName('.')).toBe('');
    expect(encodeKey("a~b!c*d(e)f'g /é")).toBe('a~b%21c%2Ad%28e%29f%27g%20/%C3%A9');
  });
});

describe('a signed request, against botocore', () => {
  it.each(SIGNED)('$method $url', (vector) => {
    const body = Buffer.from(vector.body, 'hex');
    const signed = signRequest(
      { accessKey: 'parity-s3-key', secretKey: 'parity-s3-not-a-secret', region: vector.region },
      {
        method: vector.method,
        url: new URL(vector.url),
        headers: vector.headers,
        body: body.length ? body : undefined,
      },
      new Date(Date.UTC(2026, 9, 8, 12, 34, 56)),
    );
    expect(signed['x-amz-date']).toBe(vector.date);
    expect(signed['x-amz-content-sha256']).toBe(vector.sha);
    expect(signed.authorization).toBe(vector.authorization);
  });
});

describe('the settings', () => {
  const BASE = { DJANGO_SECRET_KEY: 'unit-test-key', DATABASE_URL: 'postgresql://x/y' };
  const BUCKET = { USE_S3: '1', S3_BUCKET: 'rangon-media', S3_ACCESS_KEY: 'k', S3_SECRET_KEY: 's' };

  it('keep uploads on disk unless told otherwise', () => {
    const env = loadEnv(BASE);
    expect(env.s3).toBeNull();
    expect(env.mediaBase).toBe('/media/');
    expect(mediaStorage(env)).toBeInstanceOf(DiskStorage);
  });

  it('read the bucket as Django reads it: AWS when no endpoint is named, us-east-1 unless set', () => {
    const env = loadEnv({ ...BASE, ...BUCKET });
    expect(env.s3).toEqual({
      endpoint: null,
      bucket: 'rangon-media',
      accessKey: 'k',
      secretKey: 's',
      region: 'us-east-1',
    });
    expect(env.mediaBase).toBe(env.s3);
    expect(mediaStorage(env)).toBeInstanceOf(S3MediaStorage);
    const elsewhere = loadEnv({
      ...BASE,
      ...BUCKET,
      S3_ENDPOINT: 'https://minio.example.com',
      S3_REGION: 'eu-west-1',
    });
    expect(elsewhere.s3?.endpoint).toBe('https://minio.example.com');
    expect(elsewhere.s3?.region).toBe('eu-west-1');
  });

  it('refuse to start with a bucket half-described, and say what is missing', () => {
    expect(() => loadEnv({ ...BASE, USE_S3: '1' })).toThrow(
      'USE_S3=1 needs S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY.',
    );
    expect(() => loadEnv({ ...BASE, ...BUCKET, S3_SECRET_KEY: ' ' })).toThrow(
      'USE_S3=1 needs S3_SECRET_KEY.',
    );
  });
});

describe('S3MediaStorage', () => {
  const make = (taken: string[] = []) => {
    const objects = new Map<
      string,
      { bytes: Buffer; contentType: string; contentEncoding: unknown }
    >();
    for (const key of taken)
      objects.set(key, { bytes: Buffer.from(''), contentType: '', contentEncoding: null });
    const client = {
      exists: jest.fn(async (key: string) => objects.has(key)),
      put: jest.fn(
        async (
          key: string,
          bytes: Buffer,
          options: { contentType: string; contentEncoding?: unknown },
        ) => {
          objects.set(key, {
            bytes,
            contentType: options.contentType,
            contentEncoding: options.contentEncoding ?? null,
          });
        },
      ),
      get: jest.fn(async (key: string) => objects.get(key)?.bytes ?? null),
    };
    const storage = new S3MediaStorage(
      settings('http://s3:7070', 'us-east-1', 'rangon-parity'),
      'Asia/Dhaka',
      client as unknown as S3Client,
    );
    return { storage, client, objects };
  };
  const bytes = Buffer.from('bytes');

  it('stores an upload under the name Django would give it, with the type it came with', async () => {
    const { storage, objects } = make();
    const name = await storage.save('brands/', 'my logo.png', bytes, 'image/png');
    expect(name).toBe('brands/my_logo.png');
    expect(objects.get('brands/my_logo.png')).toEqual({
      bytes,
      contentType: 'image/png',
      contentEncoding: null,
    });
  });

  it('takes another name when a HEAD finds the first taken', async () => {
    const { storage, client } = make(['brands/logo.png']);
    const name = await storage.save('brands/', 'logo.png', bytes, 'image/png');
    expect(name).toMatch(/^brands\/logo_[A-Za-z0-9]{7}\.png$/);
    expect(client.exists).toHaveBeenCalledWith('brands/logo.png');
    expect(client.put).toHaveBeenCalledTimes(1);
  });

  it('falls back to the extension for a type, and then to the default', async () => {
    const { storage, objects } = make();
    await storage.save('x/', 'paper.pdf', bytes);
    await storage.save('x/', 'photo.webp', bytes);
    await storage.save('x/', 'scan.pdf.gz', bytes, 'application/pdf');
    await storage.save('x/', 'archive.tar.gz', bytes);
    expect(objects.get('x/paper.pdf')?.contentType).toBe('application/pdf');
    // Python's table has no `.webp` (D235): the default, not an image type.
    expect(objects.get('x/photo.webp')?.contentType).toBe('application/octet-stream');
    expect(objects.get('x/scan.pdf.gz')).toMatchObject({
      contentType: 'application/pdf',
      contentEncoding: 'gzip',
    });
    expect(objects.get('x/archive.tar.gz')).toMatchObject({
      contentType: 'application/x-tar',
      contentEncoding: 'gzip',
    });
  });

  it('reads back what is there, and nothing where nothing is', async () => {
    const { storage } = make();
    const name = await storage.save('x/', 'a.txt', bytes);
    await expect(storage.read(name)).resolves.toEqual(bytes);
    await expect(storage.read('x/none.txt')).resolves.toBeNull();
  });
});

describe('S3Client, against a server that answers as S3 does', () => {
  interface Seen {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }
  let server: Server;
  let endpoint: string;
  let seen: Seen[];
  let answers: { status: number; headers?: Record<string, string>; body?: Buffer | string }[];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers,
          body: Buffer.concat(chunks),
        });
        const answer = answers.shift() ?? { status: 500 };
        response.writeHead(answer.status, answer.headers ?? {});
        response.end(request.method === 'HEAD' ? undefined : (answer.body ?? ''));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => void server.close(() => resolve())));
  beforeEach(() => {
    seen = [];
    answers = [];
  });

  const client = () =>
    new S3Client(
      { endpoint, bucket: 'bucket', accessKey: 'key', secretKey: 'secret', region: 'us-east-1' },
      2000,
      1,
    );

  it('puts an object at its key, whole, signed, with its type and encoding', async () => {
    answers.push({ status: 200 });
    await client().put('x/a b.png.gz', Buffer.from('bytes'), {
      contentType: 'image/png',
      contentEncoding: 'gzip',
    });
    expect(seen).toHaveLength(1);
    const [request] = seen as [Seen];
    expect([request.method, request.url]).toEqual(['PUT', '/bucket/x/a%20b.png.gz']);
    expect(request.body.toString()).toBe('bytes');
    expect(request.headers['content-type']).toBe('image/png');
    expect(request.headers['content-encoding']).toBe('gzip');
    expect(request.headers['content-length']).toBe('5');
    expect(request.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=key\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=content-encoding;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it('reads an object back byte for byte, though it says it is gzip', async () => {
    const stored = Buffer.from([0x1f, 0x8b, 0x00, 0xff, 0x10]);
    answers.push({ status: 200, headers: { 'content-encoding': 'gzip' }, body: stored });
    await expect(client().get('x/a.gz')).resolves.toEqual(stored);
  });

  it('answers nothing for an object that is not there, to a GET and to a HEAD', async () => {
    answers.push({ status: 404, body: '<Error><Code>NoSuchKey</Code></Error>' }, { status: 404 });
    await expect(client().get('x/none')).resolves.toBeNull();
    await expect(client().exists('x/none')).resolves.toBe(false);
  });

  it('reads what was stored with an object', async () => {
    answers.push({
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-length': '0' },
    });
    await expect(client().head('x/a.pdf')).resolves.toEqual({
      contentType: 'application/pdf',
      contentEncoding: null,
      size: 0,
    });
  });

  it('tries again after a fault on the way, twice, and then gives up', async () => {
    answers.push({ status: 503 }, { status: 500 }, { status: 200, body: 'ok' });
    await expect(client().get('x/a')).resolves.toEqual(Buffer.from('ok'));
    expect(seen).toHaveLength(3);
    seen = [];
    answers.push({ status: 503, body: 'SlowDown' }, { status: 503 }, { status: 503 });
    await expect(client().get('x/a')).rejects.toThrow('S3 GET x/a: 503');
    expect(seen).toHaveLength(3);
  });

  it('raises what S3 decided, at once: a refusal is not a fault', async () => {
    answers.push({ status: 403, body: '<Error><Code>AccessDenied</Code></Error>' });
    const refusal = client().put('x/a', Buffer.from('b'), { contentType: 'text/plain' });
    await expect(refusal).rejects.toBeInstanceOf(S3Error);
    await expect(refusal).rejects.toThrow(
      'S3 PUT x/a: 403 <Error><Code>AccessDenied</Code></Error>',
    );
    expect(seen).toHaveLength(1);
  });
});
