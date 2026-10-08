# ADR-0018 — The NestJS API keeps uploads in S3 without an SDK

**Status:** Accepted · 2026-10-08 · closes the first limit [ADR-0017](0017-nest-api-serves-production.md) named

## Context

The NestJS API serves production (ADR-0017) and refused to start with `USE_S3=1`: uploads to
object storage were not ported. Django does it through django-storages' `S3Storage`, over boto3,
with these options (`config/settings/base.py`): `querystring_auth=False`,
`file_overwrite=False`, `default_acl=None`, no `location`, no custom domain. The go-live
checklist asks for media in object storage, so the default production stack could not meet its
own checklist.

What the API does with storage is small. It **saves** an upload (a product photograph, a
navigation or banner image, an expense receipt), which under `file_overwrite=False` is a HEAD of
the name to see whether it is taken and a PUT of the bytes; it **reads** one kind of file back
(a receipt, through the endpoint that checks who is asking); and it **names** a file's URL in
every payload that shows an image. It never deletes a stored file -- nothing in Django does --
and never lists a bucket.

CLAUDE.md asks that a dependency be justified. The obvious one here is the AWS SDK's S3 client.

## Decision

**No SDK. `apps/api-nest/src/common/s3.ts` makes the three requests itself and signs them with
AWS Signature Version 4, using `node:crypto` and `node:http(s)`.**

- **The URL of a stored file is a pure function**, `s3ObjectUrl`, of the settings and the name:
  what `S3Storage.url` prints with `querystring_auth=False`. A custom endpoint is addressed by
  path (`<endpoint>/<bucket>/<key>`); AWS itself by host where the bucket's name can be one, at
  the global endpoint whatever the region, and by path at the region's endpoint where it
  cannot. The key is the name cleaned and resolved under the bucket's top, percent-encoded as
  botocore encodes it.
- **The signature is forty lines**, and is compared with botocore's own (`S3SigV4Auth`, at a
  fixed moment) for seven requests: each method, a custom endpoint with a port, AWS by host and
  by path, keys with spaces and Bengali letters, a header whose spaces must be collapsed.
- **`MediaStorage` has two forms**, chosen by `USE_S3` as Django's settings choose: `DiskStorage`
  (`FileSystemStorage`) and `S3MediaStorage` (`S3Storage`). The naming -- `upload_to`, the valid
  file name, the underscore and seven random characters when a name is taken -- is one
  algorithm above both. An object is stored with the upload's own type (what Pillow found for an
  image, what the client claimed for a receipt), else the type its extension has in Python's
  table, else `application/octet-stream`, and with `Content-Encoding` where the name says how it is
  packed: `S3Storage._get_write_parameters`.
- **`/media/` is not mounted** with `USE_S3`, as `config.urls` does not mount it.

### Why not the SDK

`@aws-sdk/client-s3` (3.1147.0, measured 2026-10-08) installs 26 packages and 22 MB to make
three requests whose shapes are fixed. Everything it would add here is something this API does not use: multipart uploads (an
upload is at most 10 MB, and is refused above that by the serializer), credential chains,
region discovery, streaming, retries with jitter. And it would not have settled the part that
has to be exact, which is the URL: that is boto's rule for an *unsigned* URL, and an SDK for
Node has its own.

The cost of not using it is that this file is the project's to keep right. It is checked three
ways: unit tests against values printed by django-storages and botocore; a real S3 server in
the parity stack that verifies every signature; and the whole parity suite run with both APIs'
uploads in that server, comparing every stored object.

## Consequences

- **`USE_S3=1` works on the NestJS API.** It needs `S3_BUCKET`, `S3_ACCESS_KEY` and
  `S3_SECRET_KEY`, and refuses to start without them, saying which is missing. `S3_ENDPOINT`
  blank means AWS; `S3_REGION` is `us-east-1` unless set.
- **Three things boto does that this does not**, none visible to a client of the API:
  - *Credentials from elsewhere.* boto looks in an instance role, the environment's `AWS_*`
    names and `~/.aws`. Here it is the two settings or nothing.
  - *Finding the bucket's region.* boto follows S3's redirect when the region is wrong. Here a
    wrong `S3_REGION` is a refused signature: set it to the bucket's region. (The compose files
    did not pass `S3_REGION` to either API until this change; they do now.)
  - *Multipart uploads.* boto splits an object over 8 MB into parts. Here every upload is one
    PUT. The object is the same; its ETag is not, and nothing reads it.
- **Proven against one S3 server, not against AWS.** The parity stack runs the Versity gateway
  (`versity/versitygw`, pinned), which checks signatures and stores each object's type. Requests
  to AWS itself -- addressed by host, over TLS -- are built by the same code and covered by the
  signature tests, but no request has been sent to AWS from this project.
- **Two Django defects were found and are copied or stepped around**, both in the roadmap:
  `S3_PUBLIC_ENDPOINT` is read by nothing, so with a private endpoint every image URL names a
  host no browser can reach (D238, copied: the URL is Django's); and the development settings
  put storage back on disk whatever `USE_S3` says, while `/media/` is still unmounted for it
  (D237 -- not copied: under development settings the NestJS API uses the bucket it was told
  to use).
- **CI runs the whole parity suite a third time**, in a job of its own, with both APIs'
  uploads in the S3 server.

## Alternatives considered

- **`@aws-sdk/client-s3`.** Above.
- **A smaller S3 client package** (`aws4fetch`, `minio`): fewer packages, and still someone
  else's URL rule. The signing is the smaller half of this file; the half that had
  to match Django would have been written either way.
- **Leave it unsupported**, and have a shop on object storage run Django. That is where
  ADR-0017 left it, with the go-live checklist asking for the thing the default could not do.
