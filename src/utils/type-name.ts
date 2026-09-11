/**
 * Matches Express's own `gettype()`: a primitive reports its `typeof` (`string`, `number`, ...); anything else reports its `[[Class]]` via `Object.prototype.toString` (`Array`, `Date`, `Null`, `Object`, ...). Used in "requires a middleware function but got a X" style errors.
 */
export function describeType(value: unknown): string {
  const type = typeof value
  if (type !== 'object') return type
  return Object.prototype.toString.call(value).slice(8, -1)
}
