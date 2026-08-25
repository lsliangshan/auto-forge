declare module 'better-sqlite3-multiple-ciphers' {
  import type BetterSqlite3 from 'better-sqlite3'

  interface CipherDatabase extends BetterSqlite3.Database {
    key(key: Buffer): number
    rekey(key: Buffer): number
  }

  interface CipherDatabaseConstructor {
    new(filename?: string | Buffer, options?: BetterSqlite3.Options): CipherDatabase
    (filename?: string, options?: BetterSqlite3.Options): CipherDatabase
    readonly prototype: CipherDatabase
    readonly SqliteError: typeof BetterSqlite3.SqliteError
  }

  const Database: CipherDatabaseConstructor

  namespace Database {
    type Database = CipherDatabase
    type Options = BetterSqlite3.Options
    type Statement<BindParameters extends unknown[] | object = unknown[], Result = unknown> =
      BetterSqlite3.Statement<BindParameters, Result>
    type Transaction<T extends (...params: never[]) => unknown = (...params: never[]) => unknown> =
      BetterSqlite3.Transaction<T>
  }

  export = Database
}
