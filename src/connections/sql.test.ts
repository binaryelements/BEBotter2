import { describe, expect, it } from "vitest";
import { formatSql } from "./sql.js";

describe("formatSql", () => {
  it("writes a header and tab-separated rows, shows NULL, dates and binary plainly, and caps the rows", () => {
    const rows = Array.from({ length: 205 }, (_, i) => [i, i === 0 ? null : `a\tb${i}`, new Date(Date.UTC(2026, 0, 2)), Buffer.from("xy")]);
    const out = formatSql({ columns: ["id", "name", "at", "blob"], rows }).split("\n");
    expect(out[0]).toBe("id\tname\tat\tblob");
    expect(out[1]).toBe("0\tNULL\t2026-01-02T00:00:00.000Z\t<2 bytes>");
    expect(out[2]).toBe("1\ta b1\t2026-01-02T00:00:00.000Z\t<2 bytes>");
    expect(out).toHaveLength(202);
    expect(out[201]).toBe("… 5 more rows; narrow the query");
  });
  it("reports affected rows for a statement without a result", () => {
    expect(formatSql({ columns: [], rows: [], affected: 4 })).toBe("4 rows affected");
  });
});
