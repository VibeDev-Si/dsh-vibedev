/**
 * Exact decimal arithmetic for money. A value is a scaled integer
 * (`units × 10^-scale`, BigInt), so `0.5819 × 5` is `2.9095` and not
 * `2.9094999999999995`. Catalog prices arrive as JSON numbers; a number is read
 * as the decimal it is written as (its shortest round-trip form), which is the
 * literal the gateway sent.
 * @module dsh-vibedev/util/decimal
 */

/** A decimal number: `units × 10^-scale`. */
export interface Decimal {
  readonly units: bigint
  readonly scale: number
}

const PATTERN = /^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i

/**
 * The exact decimal of a finite number (as written by `String`) or a decimal string.
 * @param value - the number or text, such as `0.5819`, `1e-7` or `"3.98066354"`.
 * @returns the decimal.
 * @throws RangeError for anything that is not a finite decimal.
 */
export function decimal(value: number | string): Decimal {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError(`${value} is not a finite number`)
  const text = typeof value === 'number' ? String(value) : value.trim()
  const match = PATTERN.exec(text)
  if (match === null) throw new RangeError(`"${text}" is not a decimal number`)
  const [, sign, whole = '0', fraction = '', exponent = '0'] = match
  let digits = `${whole}${fraction}`
  let scale = fraction.length - Number(exponent)
  if (scale < 0) {
    digits += '0'.repeat(-scale)
    scale = 0
  }
  const units = BigInt(digits)
  return { units: sign === '-' ? -units : units, scale }
}

/** Zero. */
export const ZERO: Decimal = { units: 0n, scale: 0 }

function rescale(value: Decimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale)
}

/**
 * The sum of two decimals.
 * @param a - the first.
 * @param b - the second.
 * @returns `a + b`, exactly.
 */
export function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale)
  return { units: rescale(a, scale) + rescale(b, scale), scale }
}

/**
 * The product of two decimals.
 * @param a - the first.
 * @param b - the second.
 * @returns `a × b`, exactly.
 */
export function multiply(a: Decimal, b: Decimal): Decimal {
  return { units: a.units * b.units, scale: a.scale + b.scale }
}

/**
 * Round half up (away from zero) to a number of decimals.
 * @param value - the decimal.
 * @param places - decimals to keep.
 * @returns the rounded decimal.
 */
export function roundHalfUp(value: Decimal, places: number): Decimal {
  if (value.scale <= places) return value
  const factor = 10n ** BigInt(value.scale - places)
  const negative = value.units < 0n
  const rounded = ((negative ? -value.units : value.units) + factor / 2n) / factor
  return { units: negative ? -rounded : rounded, scale: places }
}

/**
 * Round up to a whole number (towards positive infinity).
 * @param value - the decimal.
 * @returns the smallest whole number not below it.
 */
export function ceil(value: Decimal): Decimal {
  if (value.scale <= 0) return value
  const factor = 10n ** BigInt(value.scale)
  const quotient = value.units / factor
  const up = value.units > 0n && value.units % factor !== 0n ? 1n : 0n
  return { units: quotient + up, scale: 0 }
}

/**
 * Exact text without trailing zeros (`2.9095`, `5`), padded to at least `minFraction` decimals.
 * @param value - the decimal.
 * @param minFraction - decimals always shown (`5.00` with 2).
 * @returns the text.
 */
export function format(value: Decimal, minFraction = 0): string {
  const negative = value.units < 0n
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, '0')
  const whole = digits.slice(0, digits.length - value.scale)
  const fraction = digits.slice(digits.length - value.scale).replace(/0+$/, '').padEnd(minFraction, '0')
  const text = fraction === '' ? whole : `${whole}.${fraction}`
  return negative && /[1-9]/.test(text) ? `-${text}` : text
}

/**
 * The nearest number, for fields typed as numbers (never for money amounts).
 * @param value - the decimal.
 * @returns the number.
 */
export function toNumber(value: Decimal): number {
  return Number(format(value))
}
