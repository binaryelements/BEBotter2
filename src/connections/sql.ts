import pg from "pg";
import mysql from "mysql2/promise";
import mssql from "mssql";
import { ConnectionError } from "./store.js";

export type SqlEngine = "postgres" | "mysql" | "mssql";
export const SQL_ENGINES = ["postgres", "mysql", "mssql"] as const;
export const DEFAULT_PORT: Record<SqlEngine, number> = { postgres: 5432, mysql: 3306, mssql: 1433 };
export type SqlConfig = { engine: SqlEngine; port: number; database: string; username: string; tls?: boolean };
export type SqlTarget = SqlConfig & { host: string; password: string };
export type SqlResult = { columns: string[]; rows: unknown[][]; affected?: number };
/** Runs one statement. readOnly: inside a read-only transaction that is always rolled back. */
export type SqlRunner = (t: SqlTarget, query: string, readOnly: boolean) => Promise<SqlResult>;

const TIMEOUT_MS = 60_000;
// shortcut: drivers fetch the whole result before it is cut to MAX_ROWS, so the tool asks for LIMIT/TOP; stream rows if huge results show up
const MAX_ROWS = 200;
const MAX_OUTPUT = 20_000;

async function runPostgres(t: SqlTarget, query: string, readOnly: boolean): Promise<SqlResult> {
  const client = new pg.Client({
    host: t.host, port: t.port, database: t.database, user: t.username, password: t.password,
    ssl: t.tls ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: TIMEOUT_MS, statement_timeout: TIMEOUT_MS, query_timeout: TIMEOUT_MS,
    ...(readOnly ? { options: "-c default_transaction_read_only=on" } : {}),
  });
  await client.connect();
  try {
    if (readOnly) await client.query("BEGIN READ ONLY");
    // the extended protocol takes one statement only, so "…; COMMIT; DROP …" cannot leave the read-only transaction
    const r = await client.query({ text: query, rowMode: "array", queryMode: "extended" } as pg.QueryArrayConfig);
    if (readOnly) await client.query("ROLLBACK");
    return { columns: r.fields.map((f) => f.name), rows: r.rows, ...(r.fields.length ? {} : { affected: r.rowCount ?? 0 }) };
  } finally {
    await client.end().catch(() => {});
  }
}

async function runMysql(t: SqlTarget, query: string, readOnly: boolean): Promise<SqlResult> {
  const conn = await mysql.createConnection({
    host: t.host, port: t.port, database: t.database, user: t.username, password: t.password,
    ...(t.tls ? { ssl: { rejectUnauthorized: false } } : {}),
    connectTimeout: TIMEOUT_MS, multipleStatements: false, dateStrings: true,
  });
  try {
    // session-wide, so a statement that commits implicitly still lands in a read-only transaction
    if (readOnly) {
      await conn.query("SET SESSION TRANSACTION READ ONLY");
      await conn.query("START TRANSACTION");
    }
    const [rows, fields] = await conn.query({ sql: query, rowsAsArray: true, timeout: TIMEOUT_MS });
    if (readOnly) await conn.query("ROLLBACK");
    if (!Array.isArray(rows)) return { columns: [], rows: [], affected: (rows as { affectedRows?: number }).affectedRows ?? 0 };
    return { columns: (fields ?? []).map((f) => f.name), rows: rows as unknown as unknown[][] };
  } finally {
    await conn.end().catch(() => {});
  }
}

async function runMssql(t: SqlTarget, query: string, readOnly: boolean): Promise<SqlResult> {
  const pool = await new mssql.ConnectionPool({
    server: t.host, port: t.port, database: t.database, user: t.username, password: t.password,
    connectionTimeout: TIMEOUT_MS, requestTimeout: TIMEOUT_MS, pool: { max: 1 },
    // shortcut: trusts any server certificate (on-premises SQL Server is usually self-signed); pin a CA if one is ever needed
    options: { encrypt: true, trustServerCertificate: true },
  }).connect();
  try {
    // SQL Server has no read-only transaction ("COMMIT; DELETE …" escapes one), so read-only needs a login that cannot write
    if (readOnly) {
      // shortcut: checks database-wide rights and sysadmin, not a grant on a single table; extend if such logins appear
      const w = await pool.request().query<{ w: number }>(
        "SELECT IS_SRVROLEMEMBER('sysadmin') + " + ["INSERT", "UPDATE", "DELETE", "ALTER", "EXECUTE", "CREATE TABLE"].map((p) => `HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', '${p}')`).join(" + ") + " AS w",
      );
      if (w.recordset[0]!.w > 0) throw new ConnectionError("This SQL Server login can change the database, so it cannot be used read-only. Use a login with only db_datareader.");
    }
    const tx = readOnly ? new mssql.Transaction(pool) : undefined;
    if (tx) await tx.begin();
    try {
      const req = tx ? new mssql.Request(tx) : pool.request();
      req.arrayRowMode = true;
      const r = await req.query(query);
      const cols = (r as unknown as { columns?: { name: string }[][] }).columns?.[0] ?? [];
      return { columns: cols.map((c) => c.name), rows: (r.recordset ?? []) as unknown as unknown[][], ...(cols.length ? {} : { affected: r.rowsAffected.reduce((a, b) => a + b, 0) }) };
    } finally {
      if (tx) await tx.rollback().catch(() => {});
    }
  } finally {
    await pool.close().catch(() => {});
  }
}

const RUNNERS: Record<SqlEngine, SqlRunner> = { postgres: runPostgres, mysql: runMysql, mssql: runMssql };
export const realSql: SqlRunner = (t, q, ro) => RUNNERS[t.engine](t, q, ro);

const cell = (v: unknown): string =>
  v === null || v === undefined ? "NULL"
  : v instanceof Date ? v.toISOString()
  : Buffer.isBuffer(v) ? `<${v.length} bytes>`
  : typeof v === "object" ? JSON.stringify(v)
  : String(v).replace(/[\t\r\n]+/g, " ");

/** Tab-separated with a header line, at most MAX_ROWS rows and MAX_OUTPUT characters. */
export function formatSql(r: SqlResult): string {
  if (!r.columns.length) return `${r.affected ?? 0} rows affected`;
  const lines = [r.columns.join("\t"), ...r.rows.slice(0, MAX_ROWS).map((row) => row.map(cell).join("\t"))];
  let out = lines.join("\n");
  if (r.rows.length > MAX_ROWS) out += `\n… ${r.rows.length - MAX_ROWS} more rows; narrow the query`;
  return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n… cut at ${MAX_OUTPUT} characters` : out;
}

/** Runs and formats; driver errors are passed on with the password masked. */
export async function querySql(run: SqlRunner, t: SqlTarget, query: string, readOnly: boolean): Promise<string> {
  if (!query.trim()) throw new ConnectionError("Give a query");
  try {
    return formatSql(await run(t, query, readOnly));
  } catch (e) {
    if (e instanceof ConnectionError) throw e;
    const msg = e instanceof Error ? e.message : "unknown error";
    throw new ConnectionError(`SQL failed: ${(t.password ? msg.replaceAll(t.password, "[secret]") : msg).slice(0, 1000)}`);
  }
}
