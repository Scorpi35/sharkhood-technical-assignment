import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BSON, Document, ObjectId } from 'mongodb';
import type { RawDocument } from '../../src/core';

const FIXTURES = resolve(__dirname, '../fixtures');

/**
 * Load an Extended JSON fixture array as RawDocuments, the way a SourceReader
 * would hand them to the pipeline: id = hex _id, sourceTs = createdAt, body = whole doc.
 */
export function loadRawFixtures(file: string, collection: string): RawDocument[] {
  const docs = BSON.EJSON.parse(readFileSync(resolve(FIXTURES, file), 'utf8')) as Document[];
  return docs.map((doc) => ({
    id: (doc._id as ObjectId).toHexString(),
    collection,
    sourceTs: doc.createdAt as Date,
    body: doc,
  }));
}

/** The same fixture, as plain parsed EJSON documents (for tests that tweak a copy). */
export function loadFixtureDocs(file: string): Document[] {
  return BSON.EJSON.parse(readFileSync(resolve(FIXTURES, file), 'utf8')) as Document[];
}
