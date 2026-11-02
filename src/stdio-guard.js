// MCP over stdio uses stdout for protocol messages. Anything a dependency prints
// with console.log (pdf.js warnings, etc.) would corrupt the stream, so send it to stderr.
for (const level of ["log", "info", "debug", "warn"]) {
  console[level] = (...args) => console.error(...args);
}
