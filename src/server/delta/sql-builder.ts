/**
 * Builds the SQL the write path runs: table names, bound parameters, and the
 * one `BEGIN ATOMIC … END` block per command (ADR-0007 decision 6).
 *
 * Values are always bound as named parameters (`:p0`, `:p1`…), never spliced
 * into the text. Identifiers (catalog, schema, table, column) are checked
 * against a strict pattern and back-quoted.
 */
import { DomainError, GUARD_STATE } from "./errors.ts";
import type { SqlStatement, SqlValue } from "./sql-client.ts";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Back-quote a checked identifier. Throws on anything else. */
export function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `\`${name}\``;
}

/**
 * Where the store's tables live: the bundle's catalog, and an optional schema
 * prefix so a preview can keep its own copy of every schema in a shared
 * catalog (`edp_vm_pr130_admin`). Production leaves the prefix empty.
 */
export interface StoreNames {
  catalog: string;
  schemaPrefix: string;
  /** `` `catalog`.`<prefix>schema`.`table` `` */
  table(schema: string, table: string): string;
}

export function createStoreNames(catalog: string, schemaPrefix = ""): StoreNames {
  ident(catalog);
  if (schemaPrefix !== "") ident(schemaPrefix);
  return {
    catalog,
    schemaPrefix,
    table: (schema, table) => `${ident(catalog)}.${ident(schemaPrefix + schema)}.${ident(table)}`,
  };
}

/** Collects bound parameters for one statement. */
export class ParameterBag {
  readonly values: Record<string, SqlValue> = {};
  private next = 0;
  /** Bind a value and return its marker, e.g. `:p3`. */
  bind(value: SqlValue): string {
    const name = `p${this.next++}`;
    this.values[name] = value;
    return `:${name}`;
  }
}

/** A guard's condition is true when the command must be refused. */
interface Guard {
  index: number;
  error: DomainError;
}

/**
 * One `BEGIN ATOMIC … END` block. Statements run in order; a guard is an
 * `IF … THEN SIGNAL` that aborts and rolls back the whole block.
 */
export class AtomicBlock {
  readonly params = new ParameterBag();
  private readonly lines: string[] = [];
  /** What {@link add} appended, in order: the only lines that can write. */
  private readonly added: string[] = [];
  private readonly declarations: string[] = [];
  private readonly guards: Guard[] = [];
  private finalSelect: string | undefined;
  private variables = 0;

  bind(value: SqlValue): string {
    return this.params.bind(value);
  }

  /** Append one statement (without its trailing semicolon). Returns its index in {@link statements}. */
  add(sql: string): number {
    const line = `${sql.trim().replace(/;$/, "")};`;
    this.lines.push(line);
    return this.added.push(line) - 1;
  }

  /**
   * Every statement {@link add} appended, in order. Guards, variables and the
   * final `SELECT` are expressions and queries, so these are the only lines
   * that can change a table.
   */
  statements(): readonly string[] {
    return this.added;
  }

  /** Declare a block-local variable set from a scalar expression; returns its name. */
  declare(type: string, valueSql: string): string {
    const name = `edp_v${this.variables++}`;
    this.declarations.push(`DECLARE ${name} ${type};`);
    this.lines.push(`SET ${name} = (${valueSql});`);
    return name;
  }

  /** Refuse with `error` (a domain error, never retried) when `refuseWhen` is true. */
  guard(refuseWhen: string, error: DomainError): void {
    const index = this.guards.length;
    this.guards.push({ index, error });
    this.signal(refuseWhen, GUARD_STATE.domain, `edp:guard:${index}`);
  }

  /** Raise a fixed guard state when `refuseWhen` is true. */
  signal(refuseWhen: string, sqlState: string, message: string): void {
    this.lines.push(
      `IF (${refuseWhen}) THEN\n  SIGNAL SQLSTATE '${sqlState}' SET MESSAGE_TEXT = '${message}';\nEND IF;`,
    );
  }

  /** The block's result: one `SELECT` run last, whose rows the runner reads. */
  select(sql: string): void {
    this.finalSelect = sql.trim().replace(/;$/, "");
  }

  /** The domain error a guard index stands for. */
  guardError(index: number): DomainError | undefined {
    return this.guards[index]?.error;
  }

  toStatement(): SqlStatement {
    const body = [
      ...this.declarations,
      ...this.lines,
      ...(this.finalSelect ? [`${this.finalSelect};`] : []),
    ];
    return {
      statement: `BEGIN ATOMIC\n${body.join("\n")}\nEND;`,
      parameters: this.params.values,
    };
  }
}
