/** The one MongoClient of the process. */
export const MONGO_CLIENT = Symbol('MongoClient');
/** Raw (source) database, e.g. provider_raw. Read by the SourceReader only. */
export const RAW_DB = Symbol('RawDb');
/** Target database, e.g. provider_domain: domain collections and run metadata. */
export const TARGET_DB = Symbol('TargetDb');
