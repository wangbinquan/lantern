/** POSIX single-quote a value for safe interpolation into a remote command. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
