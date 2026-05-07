declare module "better-sqlite3" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement {
    run(params?: unknown): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): this;
    pragma(source: string): unknown;
    transaction<T>(fn: () => T): () => T;
  }

  interface DatabaseConstructor {
    new (filename: string): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
