import { createRequire } from "node:module";

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...parameters: readonly unknown[]): RunResult;
  get(...parameters: readonly unknown[]): unknown;
  all(...parameters: readonly unknown[]): unknown[];
}

export interface DatabaseConnection {
  pragma(source: string): unknown;
  exec(source: string): unknown;
  prepare(source: string): Statement;
  transaction<Result>(operation: () => Result): () => Result;
  close(): void;
}

interface DatabaseConstructor {
  new (filename: string): DatabaseConnection;
}

interface NodeSqliteModule {
  DatabaseSync: new (filename: string) => {
    exec(source: string): void;
    prepare(source: string): Statement;
    close(): void;
  };
}

class NodeSqliteConnection implements DatabaseConnection {
  readonly #database: InstanceType<NodeSqliteModule["DatabaseSync"]>;

  constructor(filename: string, DatabaseSync: NodeSqliteModule["DatabaseSync"]) {
    this.#database = new DatabaseSync(filename);
  }

  pragma(source: string): void {
    this.#database.exec(`PRAGMA ${source}`);
  }

  exec(source: string): void {
    this.#database.exec(source);
  }

  prepare(source: string): Statement {
    return this.#database.prepare(source);
  }

  transaction<Result>(operation: () => Result): () => Result {
    return () => {
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        this.#database.exec("COMMIT");
        return result;
      } catch (error: unknown) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    };
  }

  close(): void {
    this.#database.close();
  }
}

const require = createRequire(import.meta.url);

export function openDatabase(filename: string): DatabaseConnection {
  try {
    const BetterDatabase = require("better-sqlite3") as DatabaseConstructor;
    return new BetterDatabase(filename);
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    const message = error instanceof Error ? error.message : "";
    const unavailable =
      code === "MODULE_NOT_FOUND" ||
      message.includes("Could not locate the bindings file") ||
      message.includes("NODE_MODULE_VERSION");
    if (!unavailable) {
      throw error;
    }
  }

  const nodeSqlite = require("node:sqlite") as NodeSqliteModule;
  return new NodeSqliteConnection(filename, nodeSqlite.DatabaseSync);
}

