import { t } from "elysia";

/**
 * A request schema accepting exactly one of `values`, e.g. a shared enum array.
 * Typed through `Unsafe` because Eden infers `never` for a union mapped from an array.
 */
export const literalUnion = <T extends string>(values: readonly T[]) =>
  t.Unsafe<T>(t.Union(values.map((value) => t.Literal(value))));
