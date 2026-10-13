export function jsonStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, nestedValue: unknown) =>
      typeof nestedValue === 'bigint' ? nestedValue.toString(10) : nestedValue,
    2,
  )
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
