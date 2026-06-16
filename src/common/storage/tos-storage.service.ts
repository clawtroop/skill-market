import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TosClient } from '@volcengine/tos-sdk';
import { Readable } from 'stream';
import { loadSkillMarketRuntimeConfig } from '../../skill-market/skill-market.config';

export interface UploadResult {
  key: string;
  etag?: string;
  size?: number;
}

@Injectable()
export class TosStorageService implements OnModuleInit {
  private readonly logger = new Logger('TosStorageService');
  private client!: TosClient;
  private bucket!: string;
  private prefix!: string;

  onModuleInit() {
    const cfg = loadSkillMarketRuntimeConfig();
    this.bucket = cfg.tosBucket;
    this.prefix = cfg.tosPrefix.endsWith('/') ? cfg.tosPrefix : cfg.tosPrefix + '/';

    this.client = new TosClient({
      accessKeyId: cfg.tosAccessKey,
      accessKeySecret: cfg.tosSecretKey,
      endpoint: cfg.tosEndpoint,
      region: cfg.tosRegion || 'cn-beijing',
    } as any);

    this.logger.log(`TOS initialized bucket=${this.bucket} prefix=${this.prefix} endpoint=${cfg.tosEndpoint}`);
  }

  private fullKey(key: string): string {
    if (key.startsWith(this.prefix)) return key;
    // avoid double prefix if caller passes full
    return this.prefix + key.replace(/^\//, '');
  }

  async putObject(key: string, body: Buffer | Uint8Array | string, contentType = 'application/gzip'): Promise<UploadResult> {
    const full = this.fullKey(key);
    const payload: any = typeof body === 'string' ? Buffer.from(body) : body;
    const res: any = await this.client.putObject({
      bucket: this.bucket,
      key: full,
      body: payload,
      contentType,
    });
    this.logger.debug(`TOS putObject key=${full} etag=${res?.headers?.etag || res?.etag}`);
    return {
      key: full,
      etag: res?.headers?.etag || res?.etag,
    };
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const full = this.fullKey(key);
    // Strongly prefer getObjectV2 for Volcano TOS
    try {
      const res: any = await this.client.getObjectV2({
        bucket: this.bucket,
        key: full,
        dataType: 'buffer',
      });
      const data = res?.data ?? res?.body ?? res;
      if (Buffer.isBuffer(data)) return data;
      if (data instanceof Uint8Array) return Buffer.from(data);
      if (typeof data === 'string') return Buffer.from(data);
      // If v2 returned a stream-like in data, consume it
      if (data && typeof data.pipe === 'function') {
        return this.streamToBuffer(data);
      }
    } catch (e: any) {
      this.logger.warn(`getObjectV2 buffer failed for ${full}, will try legacy: ${e?.message ?? e}`);
    }

    // Legacy fallback
    try {
      const objResp: any = await this.client.getObject({ bucket: this.bucket, key: full });
      const maybeStream = objResp?.body || objResp?.data || objResp;
      if (maybeStream && typeof maybeStream.pipe === 'function') {
        return this.streamToBuffer(maybeStream);
      }
      if (Buffer.isBuffer(maybeStream) || maybeStream instanceof Uint8Array) {
        return Buffer.from(maybeStream);
      }
    } catch (e2: any) {
      this.logger.error(`Legacy getObject also failed for ${full}: ${e2?.message ?? e2}`);
    }
    throw new Error(`Failed to fetch object buffer from TOS for key ${full}`);
  }

  async getObjectStream(key: string): Promise<Readable> {
    const full = this.fullKey(key);

    // Preferred path for Volcano TOS: getObjectV2 with stream
    try {
      const res: any = await this.client.getObjectV2({
        bucket: this.bucket,
        key: full,
        dataType: 'stream',
      });
      // Per Volcano TOS SDK guidance: the actual readable stream is usually at res.data.content
      const content = res?.data?.content || res?.data || res?.body || res;
      if (content && typeof content.pipe === 'function') {
        return content as Readable;
      }
      if (content && typeof content.on === 'function') {
        // Some streams are event emitters without .pipe directly exposed in type
        return content as Readable;
      }
    } catch (e: any) {
      this.logger.warn(`getObjectV2 stream failed for ${full}, falling back: ${e?.message ?? e}`);
    }

    // Legacy getObject fallbacks (old SDK style)
    try {
      const res: any = await this.client.getObject({ bucket: this.bucket, key: full });
      if (res && typeof res.createReadStream === 'function') {
        return res.createReadStream();
      }
      if (res && res.body && typeof res.body.pipe === 'function') {
        return res.body;
      }
      if (res && typeof res.pipe === 'function') {
        return res as Readable;
      }
      if (res && res.data && typeof res.data.pipe === 'function') {
        return res.data;
      }
      // If the legacy call somehow gave us a buffer, wrap it
      const maybeBuf = res?.data ?? res?.body ?? res;
      if (Buffer.isBuffer(maybeBuf) || maybeBuf instanceof Uint8Array) {
        const { Readable } = require('stream');
        return Readable.from(maybeBuf);
      }
    } catch (e2: any) {
      this.logger.error(`All stream attempts failed for TOS key ${full}: ${e2?.message ?? e2}`);
    }

    throw new Error(`Unable to obtain readable stream from TOS for ${full}`);
  }

  async headObject(key: string): Promise<{ contentLength?: number; contentType?: string; etag?: string }> {
    const full = this.fullKey(key);
    try {
      const res: any = await this.client.headObject({ bucket: this.bucket, key: full });
      return {
        contentLength: res?.headers?.['content-length'] ? Number(res.headers['content-length']) : undefined,
        contentType: res?.headers?.['content-type'],
        etag: res?.headers?.etag,
      };
    } catch (e) {
      return {};
    }
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  // For listing / health if needed
  async listObjects(prefix = ''): Promise<string[]> {
    const p = this.fullKey(prefix);
    const res: any = await this.client.listObjects({ bucket: this.bucket, prefix: p, maxKeys: 1000 });
    const contents = res?.data?.Contents || res?.Contents || [];
    return contents.map((c: any) => c.Key || c.key);
  }
}
