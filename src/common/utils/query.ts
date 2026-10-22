import { BadRequestException } from "@nestjs/common";

export type FilterFieldType = "string" | "boolean" | "number" | "date";

export interface FilterOptions {
  /** Whitelisted filterable fields mapped to their column type */
  allowedFields: Record<string, FilterFieldType>;
}

export interface SortOptions {
  allowedFields: string[];
  defaultSort?: string;
  defaultOrder?: "asc" | "desc";
}

/** Operators accepted for each field type */
const OPERATORS: Record<FilterFieldType, readonly string[]> = {
  string: ["eq", "contains", "in"],
  boolean: ["eq"],
  number: ["eq", "gte", "lte", "in"],
  date: ["eq", "gte", "lte"],
};

function invalidFilter(message: string): never {
  throw new BadRequestException(`Invalid filter: ${message}`);
}

/**
 * Converts a raw query string value to the field's type, rejecting malformed values with HTTP 400.
 */
function coerceValue(
  field: string,
  type: FilterFieldType,
  raw: string,
): string | number | boolean | Date {
  switch (type) {
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      return invalidFilter(`'${field}' expects true or false`);
    case "number": {
      const num = Number(raw);
      if (raw.trim() === "" || Number.isNaN(num)) {
        return invalidFilter(`'${field}' expects a number`);
      }
      return num;
    }
    case "date": {
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) {
        return invalidFilter(`'${field}' expects an ISO 8601 date`);
      }
      return date;
    }
    default:
      return raw;
  }
}

/**
 * Parses raw query parameters for filtering (literal `filter[...]` keys, see the
 * `query parser simple` setting in configure-app):
 * - filter[field]=value (exact match, typed by the field definition)
 * - filter[field][eq]=value
 * - filter[field][contains]=value (strings)
 * - filter[field][gte]=value / filter[field][lte]=value (numbers, dates)
 * - filter[field][in]=val1,val2 (strings, numbers)
 *
 * Unknown fields are ignored; invalid operators or values throw HTTP 400.
 */
export function parseFilters(
  query: Record<string, string | undefined>,
  options: FilterOptions,
): Record<string, unknown> {
  const where: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(query)) {
    if (!val || typeof val !== "string") continue;

    // Pattern: filter[field] or filter[field][operator]
    const match = key.match(/^filter\[([a-zA-Z0-9_]+)\](?:\[([a-zA-Z0-9_]+)\])?$/);
    if (!match) continue;

    const [, field, operator = "eq"] = match;
    if (!Object.hasOwn(options.allowedFields, field)) continue;

    const type = options.allowedFields[field];
    if (!OPERATORS[type].includes(operator)) {
      invalidFilter(`operator '${operator}' is not supported for '${field}'`);
    }

    if (operator === "eq") {
      where[field] = coerceValue(field, type, val);
    } else if (operator === "in") {
      where[field] = { in: val.split(",").map((s) => coerceValue(field, type, s.trim())) };
    } else {
      // Range/contains operators combine (gte+lte = a range); eq and in replace
      const value = operator === "contains" ? val : coerceValue(field, type, val);
      const prev = where[field];
      const combinable =
        typeof prev === "object" &&
        prev !== null &&
        !Array.isArray(prev) &&
        !("in" in (prev as Record<string, unknown>));
      where[field] = combinable
        ? { ...(prev as Record<string, unknown>), [operator]: value }
        : { [operator]: value };
    }
  }

  return where;
}

/**
 * Parses sort parameter, e.g. `sort=-createdAt,title`.
 * Returns an array because Prisma only accepts one field per orderBy object.
 */
export function parseSorting(
  sortParam: string | undefined,
  options: SortOptions,
): Array<Record<string, "asc" | "desc">> {
  const defaultSort = options.defaultSort || "createdAt";
  const defaultOrder = options.defaultOrder || "desc";

  const orderBy: Array<Record<string, "asc" | "desc">> = [];
  const seen = new Set<string>();

  for (const part of (sortParam ?? "").split(",").map((p) => p.trim())) {
    const isDesc = part.startsWith("-");
    const field = isDesc ? part.slice(1) : part;

    if (options.allowedFields.includes(field) && !seen.has(field)) {
      seen.add(field);
      orderBy.push({ [field]: isDesc ? "desc" : "asc" });
    }
  }

  return orderBy.length > 0 ? orderBy : [{ [defaultSort]: defaultOrder }];
}
